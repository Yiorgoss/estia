import { Option, Context, Effect, Layer, Schema } from "effect";
import { SeekerSchema } from "@/db/schema/Seeker";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { UserId } from "@/db/schema/brands";

export interface SeekerRepository {
  readonly findByUserId: (
    userId: typeof UserId.Type,
  ) => Effect.Effect<Option.Option<typeof SeekerSchema.Type>, SqlError>;
}

export const SeekerRepository = Context.Service<SeekerRepository>("SeekerRepository");

export const SeekerRepositoryLive = Layer.effect(
  SeekerRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return {
      findByUserId: (userId) =>
        Effect.gen(function* () {
          return yield* sql<Record<string, unknown>>`
            SELECT *
              FROM seekers
             WHERE user_id=${userId}
            `.pipe(
            Effect.map((rows) => rows[0]),
            Effect.map(Option.fromNullishOr),
            Effect.map(Option.map((row) => Schema.decodeUnknownSync(SeekerSchema)(row))),
          );
        }),
    } satisfies SeekerRepository; // needed otherwise email/password become untyped when using taperror
  }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => Effect.logError("Seeker repository failed", { error })),
    ),
  ),
);
