/*
 * Signed handoff tickets between the estia Worker and the Chat Durable Object.
 *
 * The Worker is the sole trust boundary that reads HttpOnly session cookies and
 * checks chat membership in D1. Before forwarding a WebSocket upgrade or an
 * internal message/read call to `env.CHATS`, the Worker strips client-supplied
 * identity headers and signs a short-lived HMAC-SHA256 ticket with the existing
 * `JWT_SECRET`. The Chat Durable Object verifies this ticket and never trusts
 * any client-supplied user id.
 */

export const CHAT_TICKET_HEADER = "x-chat-ticket";
export const CHAT_TICKET_VERSION = "v1";
export const CHAT_TICKET_TTL_SECONDS = 60;
export const CHAT_SOCKET_MAX_LIFETIME_SECONDS = 60 * 60;
export const CHAT_CLOSE_AUTH_EXPIRED = 4001;

export interface ChatTicketPayload {
  readonly userId: string;
  readonly chatId: string;
  // Unix timestamp in seconds when this handoff ticket expires.
  readonly exp: number;
  // Optional Unix timestamp in seconds when the caller's access token expires,
  // used to schedule the Durable Object expiry alarm. Defaults to `exp`.
  readonly socketExp?: number | undefined;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (encoded: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (encoded.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
};

const importHmacKey = (
  secret: string,
  usages: ReadonlyArray<"sign" | "verify">,
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [...usages],
  );

export const signChatTicket = async (
  secret: string,
  payload: ChatTicketPayload,
): Promise<string> => {
  const normalized: Record<string, string | number> = {
    userId: payload.userId,
    chatId: payload.chatId,
    exp: payload.exp,
  };
  if (payload.socketExp !== undefined) {
    normalized.socketExp = payload.socketExp;
  }
  const encodedPayload = toBase64Url(textEncoder.encode(JSON.stringify(normalized)));
  const signingInput = `${CHAT_TICKET_VERSION}.${encodedPayload}`;
  const key = await importHmacKey(secret, ["sign"]);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, textEncoder.encode(signingInput)),
  );
  return `${signingInput}.${toBase64Url(signature)}`;
};

export const signShortChatTicket = (
  secret: string,
  input: {
    readonly userId: string;
    readonly chatId: string;
    readonly socketExp?: number | undefined;
  },
): Promise<string> => {
  const nowSec = Math.floor(Date.now() / 1000);
  return signChatTicket(secret, {
    userId: input.userId,
    chatId: input.chatId,
    exp: nowSec + CHAT_TICKET_TTL_SECONDS,
    socketExp: input.socketExp,
  });
};

export const verifyChatTicket = async (
  secret: string,
  token: string,
  expectedChatId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<ChatTicketPayload | null> => {
  if (secret.length === 0 || token.length === 0) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, encodedPayload, encodedSig] = parts;
  if (version !== CHAT_TICKET_VERSION || !encodedPayload || !encodedSig) return null;

  const signatureBytes = fromBase64Url(encodedSig);
  if (signatureBytes === null) return null;

  const signingInput = `${version}.${encodedPayload}`;
  const key = await importHmacKey(secret, ["verify"]);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    textEncoder.encode(signingInput),
  );
  if (!valid) return null;

  const payloadBytes = fromBase64Url(encodedPayload);
  if (payloadBytes === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(payloadBytes));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const userId = record["userId"];
  const chatId = record["chatId"];
  const exp = record["exp"];
  const socketExp = record["socketExp"];

  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof chatId !== "string" || chatId !== expectedChatId) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  if (nowSeconds >= exp) return null;

  if (socketExp !== undefined) {
    if (typeof socketExp !== "number" || !Number.isFinite(socketExp)) return null;
    if (nowSeconds >= socketExp) return null;
    return { userId, chatId, exp, socketExp };
  }

  return { userId, chatId, exp };
};
