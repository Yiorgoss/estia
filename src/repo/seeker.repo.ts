import { Option, Context, Effect, Layer } from "effect"
import { SeekerSchema } from "@/db/schema/Seeker"
import { SqlClient, SqlError } from "@effect/sql";
import { UserId } from "@/brands";


export interface SeekerRepository {
  readonly findByUserId: (userId: typeof UserId.Type) => Effect.Effect<Option.Option<typeof SeekerSchema.Type>, SqlError.SqlError>;
}

export const SeekerRepository = Context.GenericTag<SeekerRepository>("SeekerRepository");

export const SeekerRepositoryLive = Layer.effect(
  SeekerRepository,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    return {
      findByUserId: (userId) =>
        Effect.gen(function*() {
          return yield* sql<typeof SeekerSchema.Type>`
            SELECT *
              FROM seekers
             WHERE user_id=${userId}
         RETURNING *;
            `
            .pipe(
              Effect.map(rows => rows[0]),
              Effect.map(Option.fromNullable)
            )

        })
    } satisfies SeekerRepository // needed otherwise email/password become untyped when using taperror
  }).pipe(
    Effect.tapError(error =>
      Effect.sync(() =>
        Effect.logError("Seeker repository failed", { error })
      )
    )
  )
)
