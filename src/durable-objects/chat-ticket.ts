/*
 * The ticket the Worker hands the chat object for one connection.
 *
 * The object is only reachable through the Worker, but it must not take a
 * caller's word for who that caller is: whoever names the sender names the
 * reader, and fan-out is addressed by connection tag. So the Worker - which is
 * the only place the session cookie is verified and chat membership is checked
 * against D1 - signs a short-lived ticket with the secret the app already uses
 * for its access tokens, and the object accepts an identity only from a ticket
 * whose signature it can verify.
 *
 * The payload carries an id, a chat id, and an expiry, and nothing else: the
 * object needs no name, no role and no message. A ticket is good for one
 * connection and one minute - long enough for the upgrade to arrive, short enough
 * that a leaked ticket is cold before it is worth stealing. The `exp` also
 * caps how long a live socket may stay authorised, which the object enforces
 * with an alarm.
 */

export const CHAT_TICKET_HEADER = "x-chat-ticket";

// The window between the Worker signing and the object verifying. The upgrade is
// one round trip inside one colo, so a minute is generous and still short.
export const CHAT_TICKET_TTL_MS = 60_000;

export interface ChatTicket {
  readonly userId: string;
  readonly chatId: number;
  readonly exp: number;
}

const encoder = new TextEncoder();

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (value: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat(
    (4 - (value.length % 4)) % 4,
  )}`;
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
};

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

/*
 * The wire form is `payload.signature`, both base64url. The payload is JSON so a
 * verification failure can say which field was wrong, and the fields are short
 * names because the whole string travels in a header.
 */
export const signChatTicket = async (secret: string, ticket: ChatTicket): Promise<string> => {
  const payload = base64Url(
    encoder.encode(JSON.stringify({ u: ticket.userId, c: ticket.chatId, e: ticket.exp })),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload)),
  );
  return `${payload}.${base64Url(signature)}`;
};

/*
 * A ticket is valid only when the signature verifies, the payload decodes to the
 * three expected fields, and its expiry has not passed. Verification is the
 * subtle-crypto comparison, so it is constant time; every failure answers
 * `undefined` rather than describing what was wrong, because the only caller is
 * the object and it answers the socket with the same refusal either way.
 */
export const verifyChatTicket = async (
  secret: string,
  raw: string,
  now: number,
): Promise<ChatTicket | undefined> => {
  const separator = raw.indexOf(".");
  if (separator <= 0) return undefined;
  const payload = raw.slice(0, separator);
  const signature = fromBase64Url(raw.slice(separator + 1));
  if (signature === undefined) return undefined;

  const verified = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    encoder.encode(payload),
  );
  if (!verified) return undefined;

  const bytes = fromBase64Url(payload);
  if (bytes === undefined) return undefined;

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof decoded !== "object" || decoded === null) return undefined;

  const { u, c, e } = decoded as {
    readonly u?: unknown;
    readonly c?: unknown;
    readonly e?: unknown;
  };
  if (typeof u !== "string" || u === "") return undefined;
  if (typeof c !== "number" || !Number.isSafeInteger(c) || c <= 0) return undefined;
  if (typeof e !== "number" || !Number.isFinite(e)) return undefined;
  if (e <= now) return undefined;

  return { userId: u, chatId: c, exp: e };
};
