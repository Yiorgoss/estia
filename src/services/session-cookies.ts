import { Cookies } from "effect/http";
import { Effect } from "effect";

/*
 * The one rule for ending a session cookie on the device. A cleared cookie is
 * the cookie the app issued with an empty value and no lifetime left, so the
 * browser drops the one it holds instead of keeping it beside anything issued
 * later. The path and flags must match the issued cookie exactly - a mismatch
 * leaves the old cookie in place - so every caller passes the same options
 * record its `asCookie` uses rather than restating them.
 */
export const clearedCookie = (
  name: string,
  options: NonNullable<Cookies.Cookie["options"]>,
): Effect.Effect<[name: string, value: string, options?: Cookies.Cookie["options"]], never> =>
  Effect.succeed([name, "", { ...options, maxAge: 0, expires: new Date(0) }]);
