import { InternalError } from "@/errors";
import { Effect, Option, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

/*
 * Every failure the repository layer can raise, in one place.
 *
 * A repository owns infrastructure failure only: the statement did not run, or
 * the row the database answered cannot be decoded. A domain refusal - "not
 * found", "forbidden", "already taken" - belongs to the service that has the
 * request context to name it, so services map this union onto their own errors.
 *
 * D1 reports every driver failure as `SqlError` whose reason is
 * `UnknownError` (`@effect/sql-d1` classifies nothing finer), so the operation
 * name, not the reason, is what identifies the failure in a log line.
 */

// --- SQL ---

export class SqlQueryError extends Schema.TaggedError<SqlQueryError>()("SqlQueryError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

// --- row decoding ---

export class RowDecodeError extends Schema.TaggedError<RowDecodeError>()("RowDecodeError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/*
 * The invariant the SQL writer assumed did not hold: an INSERT/UPDATE ... RETURNING
 * that matched nothing, or a cursor that pointed at a row the query did not
 * answer. This is a bug in the statement or in the caller, never a user error,
 * so it stays a defect and surfaces as a 500 without a typed contract.
 */
export class RepositoryInvariantError extends Schema.TaggedError<RepositoryInvariantError>()(
  "RepositoryInvariantError",
  { operation: Schema.String, detail: Schema.String },
) {}

// --- object storage ---

export class R2UploadError extends Schema.TaggedError<R2UploadError>()("R2UploadError", {
  cause: Schema.Defect(),
}) {}

export class R2ReadError extends Schema.TaggedError<R2ReadError>()("R2ReadError", {
  cause: Schema.Defect(),
}) {}

export class R2DeleteError extends Schema.TaggedError<R2DeleteError>()("R2DeleteError", {
  cause: Schema.Defect(),
}) {}

// --- domain lookups answered by a repository read ---

export class RefreshTokenNotFoundError extends Schema.TaggedError<RefreshTokenNotFoundError>()(
  "RefreshTokenNotFoundError",
  {},
) {}

// --- unions ---

export type RepositoryError = SqlQueryError | RowDecodeError;
export type StorageError = R2UploadError | R2ReadError | R2DeleteError;
export type AnyRepositoryError = RepositoryError | StorageError | RefreshTokenNotFoundError;

// --- helpers two dozen call sites share ---

/*
 * Every statement goes through here: one operation name, one log line, one span.
 * `operation` is the repository method, for example "ListingRepository.search".
 */
export const query = <A, R = never>(
  operation: string,
  effect: Effect.Effect<A, SqlError, R>,
): Effect.Effect<A, SqlQueryError, R> =>
  effect.pipe(
    Effect.mapError((cause) => new SqlQueryError({ operation, cause })),
    Effect.tapError((error) => Effect.logError("Repository query failed", { error })),
    Effect.withSpan(operation),
  );

export const decodeRow = <T, RD>(
  operation: string,
  schema: Schema.ConstraintDecoder<T, RD>,
  row: unknown,
): Effect.Effect<T, RowDecodeError, RD> =>
  Schema.decodeUnknownEffect(schema)(row).pipe(
    Effect.mapError((cause) => new RowDecodeError({ operation, cause })),
    Effect.tapError((error) => Effect.logError("Repository row decode failed", { error })),
  );

export const decodeRows = <T, RD>(
  operation: string,
  schema: Schema.ConstraintDecoder<T, RD>,
  rows: ReadonlyArray<unknown>,
): Effect.Effect<ReadonlyArray<T>, RowDecodeError, RD> =>
  Effect.forEach(rows, (row) => decodeRow(operation, schema, row));

/*
 * The old `decodeSingle`: a `RETURNING` statement that matched one row answered
 * one row, so an empty result means the statement text and the caller disagree.
 * That is a defect, not a user error, so it dies with a named error instead of an
 * anonymous thrown value and still surfaces as a 500.
 */
export const decodeSingle = <T, RD>(
  operation: string,
  schema: Schema.ConstraintDecoder<T, RD>,
  rows: ReadonlyArray<unknown>,
): Effect.Effect<T, RowDecodeError, RD> =>
  Option.match(Option.fromNullishOr(rows[0]), {
    onNone: () =>
      Effect.die(new RepositoryInvariantError({ operation, detail: "RETURNING produced no row" })),
    onSome: (row) => decodeRow(operation, schema, row),
  });

const isStorageError = (error: unknown): error is StorageError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error._tag === "R2UploadError" ||
    error._tag === "R2ReadError" ||
    error._tag === "R2DeleteError");

const isRepositoryError = (error: unknown): error is RepositoryError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error._tag === "SqlQueryError" || error._tag === "RowDecodeError");

/*
 * Collapse repository and storage infrastructure failures into the app-wide
 * `InternalError` (500), leaving any domain errors in the channel untouched.
 * `SqlQueryError` and `RowDecodeError` are already logged by `query` and
 * `decodeRow` with their operation name; `StorageError` is logged here before
 * collapsing so every 500 still has a cause in the log.
 */
export const toInternalError = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, RepositoryError | StorageError> | InternalError, R> =>
  Effect.catch(
    effect,
    (error): Effect.Effect<never, Exclude<E, RepositoryError | StorageError> | InternalError> => {
      if (isStorageError(error)) {
        return Effect.logError("Storage operation failed", { error }).pipe(
          Effect.andThen(Effect.fail(new InternalError())),
        );
      }
      if (isRepositoryError(error)) {
        return Effect.fail(new InternalError());
      }
      return Effect.fail(error as Exclude<E, RepositoryError | StorageError>);
    },
  );
