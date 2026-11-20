import { signChatTicket, verifyChatTicket } from "@/services/chat-ticket";
import { assert, describe, it } from "@effect/vitest";

const SECRET = "test-chat-ticket-secret-value";
const NOW = 1_750_000_000;

describe("chat-ticket HMAC signing and verification", () => {
  it("accepts a valid ticket for the matching chatId before expiry", async () => {
    const token = await signChatTicket(SECRET, {
      userId: "user-123",
      chatId: "chat-abc-123",
      exp: NOW + 60,
      socketExp: NOW + 3600,
    });

    const verified = await verifyChatTicket(SECRET, token, "chat-abc-123", NOW + 10);
    assert.isNotNull(verified);
    assert.strictEqual(verified?.userId, "user-123");
    assert.strictEqual(verified?.chatId, "chat-abc-123");
    assert.strictEqual(verified?.exp, NOW + 60);
    assert.strictEqual(verified?.socketExp, NOW + 3600);
  });

  it("refuses a forged or tampered ticket", async () => {
    const token = await signChatTicket(SECRET, {
      userId: "user-123",
      chatId: "chat-abc-123",
      exp: NOW + 60,
    });

    // Wrong signing secret.
    assert.isNull(await verifyChatTicket("wrong-secret", token, "chat-abc-123", NOW));

    // Tampered signature.
    const [ver, payload, sig] = token.split(".");
    const tamperedSig = `${ver}.${payload}.${sig?.slice(0, -2)}AA`;
    assert.isNull(await verifyChatTicket(SECRET, tamperedSig, "chat-abc-123", NOW));

    // Tampered payload with original signature.
    const forgedPayload = Buffer.from(
      JSON.stringify({ userId: "victim-user", chatId: "chat-abc-123", exp: NOW + 60 }),
    ).toString("base64url");
    const tamperedPayload = `${ver}.${forgedPayload}.${sig}`;
    assert.isNull(await verifyChatTicket(SECRET, tamperedPayload, "chat-abc-123", NOW));

    // Valid ticket presented to a different chatId.
    assert.isNull(await verifyChatTicket(SECRET, token, "chat-different", NOW));
  });

  it("refuses an expired ticket", async () => {
    const token = await signChatTicket(SECRET, {
      userId: "user-123",
      chatId: "chat-abc-123",
      exp: NOW + 30,
    });

    assert.isNull(await verifyChatTicket(SECRET, token, "chat-abc-123", NOW + 30));
    assert.isNull(await verifyChatTicket(SECRET, token, "chat-abc-123", NOW + 120));
  });
});
