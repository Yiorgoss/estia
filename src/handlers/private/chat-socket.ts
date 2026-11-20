import { JWTSchema, RefreshTokenValue } from "@/db/schema/brands";
import { decodeChatId } from "@/db/schema/Chat";
import { ChatRepository } from "@/repos/chat.repo";
import { UserRepository } from "@/repos/user.repo";
import { AuthService } from "@/services/auth.service";
import {
  CHAT_TICKET_HEADER,
  signShortChatTicket,
} from "@/services/chat-ticket";
import { JWTService } from "@/services/jwt.service";
import { RefreshTokenService } from "@/services/refresh-token.service";
import { Effect, Option, Schema } from "effect";
import type { Cookies } from "effect/http";

/*
 * Worker trust boundary for WebSocket upgrades to `/api/chats/:id/socket`.
 *
 * Runs before the Effect HTTP router so a Cloudflare `101 Switching Protocols`
 * response with its attached `WebSocket` travels directly back to the client.
 *
 * Security invariants:
 * 1. Verifies the HttpOnly `access_token` cookie and falls back to rotating the
 *    `refresh_token` cookie through the same `AuthService.tokenAuthFlow` used
 *    by `AuthMiddleware`.
 * 2. Verifies the account still exists in D1 and is a participant of the chat.
 * 3. Rejects cross-origin browser upgrades when an `Origin` header is present.
 * 4. Strips every client-supplied header (including any spoofed `x-*` identity
 *    headers or `?userId=` query param) and signs a short HMAC ticket carrying
 *    `{ userId, chatId, exp, socketExp }` with `JWT_SECRET`.
 * 5. Attaches rotated `Set-Cookie` headers onto the `101` response when a
 *    refresh rotation occurred.
 */

export interface ChatSocketEnv {
  readonly CHATS: DurableObjectNamespace;
  readonly JWT_SECRET: string;
}

const FORWARDED_WS_HEADERS = [
  "upgrade",
  "connection",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
] as const;

const parseCookieHeader = (header: string | null): Record<string, string> => {
  const cookies: Record<string, string> = {};
  if (header === null || header.trim() === "") return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name.length > 0) {
      cookies[name] = value;
    }
  }
  return cookies;
};

const formatSameSite = (value: "strict" | "lax" | "none"): string =>
  value === "strict" ? "Strict" : value === "none" ? "None" : "Lax";

const serializeSetCookie = (
  entry: readonly [name: string, value: string, options?: Cookies.Cookie["options"]],
): string => {
  const [name, value, options] = entry;
  const parts = [`${name}=${value}`];
  if (options !== undefined) {
    if (options.maxAge !== undefined) {
      const maxAgeSeconds =
        typeof options.maxAge === "number" ? Math.floor(options.maxAge / 1000) : 0;
      parts.push(`Max-Age=${Math.max(0, maxAgeSeconds)}`);
    }
    if (options.expires instanceof Date) {
      parts.push(`Expires=${options.expires.toUTCString()}`);
    }
    if (options.path !== undefined) {
      parts.push(`Path=${options.path}`);
    }
    if (options.domain !== undefined) {
      parts.push(`Domain=${options.domain}`);
    }
    if (options.httpOnly === true) {
      parts.push("HttpOnly");
    }
    if (options.secure === true) {
      parts.push("Secure");
    }
    if (options.sameSite !== undefined) {
      parts.push(`SameSite=${formatSameSite(options.sameSite)}`);
    }
  }
  return parts.join("; ");
};

const isSameOriginUpgrade = (request: Request): boolean => {
  const originHeader = request.headers.get("origin");
  if (originHeader === null) return true;
  try {
    return new URL(originHeader).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
};

export const matchChatSocketPath = (pathname: string): string | null => {
  const match = /^\/api\/chats\/([^/]+)\/socket$/.exec(pathname);
  return match?.[1] ?? null;
};

export const handleChatSocketUpgrade = (
  request: Request,
  env: ChatSocketEnv,
): Effect.Effect<
  Response,
  never,
  AuthService | JWTService | RefreshTokenService | UserRepository | ChatRepository
> =>
  Effect.gen(function* () {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const rawChatId = matchChatSocketPath(url.pathname);
    const chatId = rawChatId === null ? undefined : decodeChatId(decodeURIComponent(rawChatId));
    if (chatId === undefined) {
      return new Response("Not Found", { status: 404 });
    }

    if (!isSameOriginUpgrade(request)) {
      return new Response("Forbidden", { status: 403 });
    }

    const cookies = parseCookieHeader(request.headers.get("cookie"));
    const accessToken = yield* Schema.decodeUnknownEffect(JWTSchema)(cookies["access_token"]).pipe(
      Effect.catchTags({ SchemaError: () => Effect.succeed(null) }),
    );
    const refreshToken = yield* Schema.decodeUnknownEffect(RefreshTokenValue)(
      cookies["refresh_token"],
    ).pipe(Effect.catchTags({ SchemaError: () => Effect.succeed(null) }));

    if (accessToken === null && refreshToken === null) {
      return new Response("Unauthorized", { status: 401 });
    }

    const auth = yield* AuthService;
    const jwtService = yield* JWTService;
    const refreshTokenService = yield* RefreshTokenService;
    const userRepo = yield* UserRepository;
    const chatRepo = yield* ChatRepository;

    const authResult = yield* auth
      .tokenAuthFlow({ accessToken, refreshToken }, request.headers.get("user-agent") ?? "")
      .pipe(
        Effect.map((value) => ({ _tag: "ok" as const, value })),
        Effect.catchTags({
          RefreshTokenRotatedError: () => Effect.succeed({ _tag: "unauthorized" as const }),
          InvalidJWTError: () => Effect.succeed({ _tag: "unauthorized" as const }),
          ExpiredJWTError: () => Effect.succeed({ _tag: "unauthorized" as const }),
          UnauthorizedError: () => Effect.succeed({ _tag: "unauthorized" as const }),
          UserNotFoundError: () => Effect.succeed({ _tag: "unauthorized" as const }),
          RefreshTokenNotFoundError: () => Effect.succeed({ _tag: "unauthorized" as const }),
          InternalError: () => Effect.succeed({ _tag: "unauthorized" as const }),
        }),
      );

    if (authResult._tag !== "ok") {
      return new Response("Unauthorized", { status: 401 });
    }

    const { user, tokens } = authResult.value;
    const rotated = tokens.accessToken !== accessToken || tokens.refreshToken !== refreshToken;

    const setCookieHeaders: Array<string> = [];
    if (rotated) {
      if (tokens.accessToken != null) {
        setCookieHeaders.push(serializeSetCookie(yield* jwtService.asCookie(tokens.accessToken)));
      }
      if (tokens.refreshToken != null) {
        setCookieHeaders.push(
          serializeSetCookie(yield* refreshTokenService.asCookie(tokens.refreshToken)),
        );
      }
    }

    const withRotatedCookies = (response: Response): Response => {
      if (setCookieHeaders.length === 0) return response;
      const headers = new Headers(response.headers);
      for (const cookie of setCookieHeaders) {
        headers.append("set-cookie", cookie);
      }
      if (response.status === 101 && "webSocket" in response) {
        return new Response(null, {
          status: 101,
          headers,
          webSocket: response.webSocket,
        });
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };

    // Verify the account still exists in D1 rather than trusting only the token.
    const storedUser = yield* userRepo.findById(user.id).pipe(
      Effect.catchTags({ SqlError: () => Effect.succeed(Option.none()) }),
    );
    if (Option.isNone(storedUser)) {
      return withRotatedCookies(new Response("Unauthorized", { status: 401 }));
    }

    // Read the access token's expiry so the DO alarm closes the socket when the
    // access token expires.
    let socketExp: number | undefined;
    if (tokens.accessToken != null) {
      socketExp = yield* jwtService.verify(tokens.accessToken).pipe(
        Effect.map((obj) => obj.payload.exp as number | undefined),
        Effect.catch(() => Effect.succeed(undefined)),
      );
    }

    const chatExists = yield* chatRepo.findById(chatId).pipe(
      Effect.catchTags({ SqlError: () => Effect.succeed(Option.none()) }),
    );
    if (Option.isNone(chatExists)) {
      return withRotatedCookies(new Response("Not Found", { status: 404 }));
    }

    const isMember = yield* chatRepo.isParticipant(chatId, user.id).pipe(
      Effect.catchTags({ SqlError: () => Effect.succeed(false) }),
    );
    if (!isMember) {
      return withRotatedCookies(new Response("Forbidden", { status: 403 }));
    }

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return withRotatedCookies(new Response("Upgrade Required", { status: 426 }));
    }

    const ticket = yield* Effect.tryPromise({
      try: () => signShortChatTicket(env.JWT_SECRET, { userId: user.id, chatId, socketExp }),
      catch: () => "ticket_error" as const,
    }).pipe(Effect.catch(() => Effect.succeed(null)));

    if (ticket === null) {
      return withRotatedCookies(new Response("Internal Server Error", { status: 500 }));
    }

    // Strip every client-supplied header (including any spoofed x-* identity
    // headers) and copy only the WebSocket handshake headers plus our signed ticket.
    const forwardedHeaders = new Headers();
    for (const headerName of FORWARDED_WS_HEADERS) {
      const value = request.headers.get(headerName);
      if (value !== null) {
        forwardedHeaders.set(headerName, value);
      }
    }
    forwardedHeaders.set(CHAT_TICKET_HEADER, ticket);

    // Build a sanitized internal URL that preserves only a valid `?after=` seq
    // and drops any client-supplied query params such as `?userId=`.
    const doUrl = new URL(`https://chat.internal/chats/${encodeURIComponent(chatId)}/socket`);
    const rawAfter = url.searchParams.get("after");
    if (rawAfter !== null && /^\d+$/.test(rawAfter)) {
      doUrl.searchParams.set("after", rawAfter);
    }

    const stub = env.CHATS.get(env.CHATS.idFromName(chatId));
    const doResponse = yield* Effect.tryPromise({
      try: () => stub.fetch(new Request(doUrl.toString(), { method: "GET", headers: forwardedHeaders })),
      catch: () => null,
    }).pipe(Effect.catch(() => Effect.succeed(null)));

    if (doResponse === null) {
      return withRotatedCookies(new Response("Bad Gateway", { status: 502 }));
    }

    return withRotatedCookies(doResponse);
  });
