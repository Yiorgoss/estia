import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";

/*
 * Keyset cursor: the `(created_at, id)` of the last row a caller received. It is
 * encoded at the HTTP boundary; the service and repository take the struct so
 * neither has to know the wire encoding. Every paged feed shares this one shape,
 * so a new feed cannot invent a second paging contract.
 */
export const KeysetCursor = Schema.Struct({
  createdAt: Schema.Number,
  id: Schema.Number,
});
export type KeysetCursor = typeof KeysetCursor.Type;

/*
 * The cursor travels as `base64url("<createdAt>:<id>")`, so the sort key is not
 * a JSON field and there is no offset parameter to page with. It is
 * tamper-tolerant, not tamper-proof: a forged cursor is accepted, which is
 * harmless because it only moves the keyset window - each feed still decides
 * which rows exist for it.
 */
const CURSOR_PATTERN = /^(\d+):(\d+)$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const encodeKeysetCursor = (cursor: typeof KeysetCursor.Encoded): string =>
  btoa(`${cursor.createdAt}:${cursor.id}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const decodeKeysetCursor = (value: string): typeof KeysetCursor.Encoded | undefined => {
  // Only the base64url alphabet is accepted, so standard base64 (`+`, `/`, `=`)
  // is a malformed cursor instead of being silently normalised.
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined;

  let decoded: string;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    decoded = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
  } catch {
    return undefined;
  }

  const match = CURSOR_PATTERN.exec(decoded);
  if (match === null) return undefined;
  const createdAt = Number(match[1]);
  const id = Number(match[2]);
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(id)) return undefined;

  return { createdAt, id };
};

// The string form of a cursor. Decoding a malformed cursor fails the request
// instead of dropping the filter and silently starting from the first page.
export const KeysetCursorFromString: Schema.Codec<typeof KeysetCursor.Type, string> =
  Schema.String.pipe(
    Schema.decodeTo(
      KeysetCursor,
      SchemaTransformation.transformEffect({
        decode: (value, options) => {
          const cursor = decodeKeysetCursor(value);
          return cursor === undefined
            ? Effect.fail(
                new SchemaIssue.InvalidValue({ message: "Invalid cursor" }, value, options),
              )
            : Effect.succeed(cursor);
        },
        encode: (cursor) => Effect.succeed(encodeKeysetCursor(cursor)),
      }),
    ),
  );
