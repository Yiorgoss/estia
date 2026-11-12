import { decodeChatId } from "@/db/schema/Chat";
import { CHAT_CONNECT_PATH } from "@/durable-objects/chat-core";
import { CHAT_TICKET_HEADER } from "@/durable-objects/chat-ticket";
import { sessionResolver } from "@/handlers/optional-caller";
import { ChatRepository } from "@/repos/chat.repo";
import type { AuthService } from "@/services/auth.service";
import { ChatTicketService } from "@/services/chat-ticket.service";
import type { JWTService } from "@/services/jwt.service";
import type { RefreshTokenService } from "@/services/refresh-token.service";
import { Cookies } from "effect/http";
import { Effect } from "effect";

/*
 * The Worker's half of a chat socket upgrade, and the only place a socket's
 * identity is decided.
 *
 * A browser sends the same HttpOnly session cookies on a WebSocket handshake that
 * it sends on a page load, so the upgrade runs the app's one session resolver -
 * the live access token, or a rotation through the refresh token. That is the
 * whole reason no token travels in a query string: query strings land in access
 * logs, referrers and error reports, and the cookie is already the session.
 *
 * The account is then proved a participant of the chat in D1, before any socket
 * exists. Only after that does the Worker sign the short ticket the object
 * verifies. The request it forwards carries the ticket and the upgrade, and
 * nothing the client said about itself: a client header naming a user is not
 * forwarded, so the object cannot be told who the reader is by the browser.
 */

export const CHAT_SOCKET_PATH = /^\/api\/chats\/([^/]+)\/socket$/;

export type ChatSocketServices =
  | AuthService
  | JWTService
  | RefreshTokenService
  | ChatRepository
  | ChatTicketService;

export const isChatSocketPath = (request: Request): boolean =>
  CHAT_SOCKET_PATH.test(new URL(request.url).pathname);

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const refusal = (code: string, message: string, status: number): Response =>
  json({ error: code, message }, status);

const withSessionCookies = (
  response: Response,
  cookies: ReadonlyArray<readonly [string, string, Cookies.Cookie["options"]?]>,
): Response => {
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [name, value, cookieOptions] of cookies) {
    headers.append(
      "set-cookie",
      Cookies.serializeCookie(Cookies.makeCookieUnsafe(name, value, cookieOptions)),
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/*
 * A browser labels its own WebSocket handshake with the page's origin, so a page
 * on another site is refused even though the session cookie is `SameSite=Lax` and
 * would normally keep the handshake anonymous anyway. A non-browser client sends
 * no origin and keeps the access it has always had; the ticket check is the real
 * gate on the object either way.
 */
const isCrossSiteOrigin = (request: Request): boolean => {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
};

export interface ChatSocketUpgradeOptions {
  readonly request: Request;
  readonly chats: DurableObjectNamespace;
  readonly run: <A, E>(effect: Effect.Effect<A, E, ChatSocketServices>) => Promise<A>;
}

export const handleChatSocketUpgrade = async (
  options: ChatSocketUpgradeOptions,
): Promise<Response> => {
  const url = new URL(options.request.url);
  const match = CHAT_SOCKET_PATH.exec(url.pathname);
  const chatId = match === null ? undefined : decodeChatId(match[1]);
  // A path segment that is not a chat id is a 404 here, before any session work.
  if (chatId === undefined) return refusal("not_found", "No such chat.", 404);

  if ((options.request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return refusal("upgrade_required", "A chat socket needs a WebSocket upgrade.", 426);
  }
  if (isCrossSiteOrigin(options.request)) {
    return refusal("forbidden_origin", "A chat socket opens from this site's own pages.", 403);
  }

  const cookies = Cookies.parseHeader(options.request.headers.get("cookie") ?? "");
  const userAgent = options.request.headers.get("user-agent") ?? "";

  const authorisation = await options.run(
    Effect.gen(function* () {
      const resolve = yield* sessionResolver;
      const session = yield* resolve({ cookies, userAgent });
      // A rotation race has no page to reload here: the client reconnects and the
      // browser presents the pair the winner wrote.
      if (session._tag === "retry") return { _tag: "retry" } as const;
      if (session._tag === "anonymous") return { _tag: "anonymous" } as const;

      const repo = yield* ChatRepository;
      const member = yield* repo.isParticipant(chatId, session.caller);
      if (!member) return { _tag: "forbidden" } as const;

      const tickets = yield* ChatTicketService;
      const ticket = yield* tickets.sign({
        userId: session.caller,
        chatId,
        sessionExpiresAt: session.accessExpiresAt,
      });
      return { _tag: "authorised", ticket, cookies: session.cookies } as const;
    }).pipe(
      Effect.catchTags({
        SqlError: () => Effect.succeed({ _tag: "unavailable" } as const),
        ChatTicketSigningError: () => Effect.succeed({ _tag: "unavailable" } as const),
      }),
    ),
  );

  if (authorisation._tag === "anonymous" || authorisation._tag === "retry") {
    return refusal("unauthorized", "Sign in to open this chat.", 401);
  }
  if (authorisation._tag === "forbidden") {
    return refusal("forbidden", "That chat is not yours.", 403);
  }
  if (authorisation._tag === "unavailable") {
    return refusal("unavailable", "Chats are unavailable just now.", 503);
  }

  const after = url.searchParams.get("after") ?? "0";
  const forward = new Request(
    `https://chat.internal${CHAT_CONNECT_PATH}?after=${encodeURIComponent(after)}`,
    {
      headers: {
        upgrade: "websocket",
        [CHAT_TICKET_HEADER]: authorisation.ticket,
      },
    },
  );

  const stub = options.chats.get(options.chats.idFromName(String(chatId)));
  const response = await stub.fetch(forward);

  if (response.status !== 101) {
    return withSessionCookies(response, authorisation.cookies);
  }
  if (response.webSocket === null) return response;
  if (authorisation.cookies.length === 0) return response;

  /*
   * The session may have been rotated on the way here. A 101 is still a response
   * the browser applies cookies from, so the new pair rides on it exactly as it
   * would on a page response.
   */
  const headers = new Headers(response.headers);
  for (const [name, value, cookieOptions] of authorisation.cookies) {
    headers.append(
      "set-cookie",
      Cookies.serializeCookie(Cookies.makeCookieUnsafe(name, value, cookieOptions)),
    );
  }
  return new Response(null, { status: 101, webSocket: response.webSocket, headers });
};
