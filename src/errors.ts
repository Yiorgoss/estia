import { Schema } from "effect";

/*
 * App-wide errors shared across repositories, services, and HTTP boundaries.
 * Kept at the root of `src/` so neither repositories nor handlers have to
 * import a domain service to name a generic 500 failure.
 */
export class InternalError extends Schema.TaggedError<InternalError>()("InternalError", {}) {}
