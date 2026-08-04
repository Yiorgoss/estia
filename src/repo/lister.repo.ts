import { Option, Context, Effect, Layer } from "effect"
import { ListerSchema } from "@/db/schema/Lister"
import { SqlClient, SqlError } from "@effect/sql";
import { UserId } from "@/brands";


export interface ListerRepository {
  readonly findByUserId: (userId: typeof UserId.Type) => Effect.Effect<Option.Option<typeof ListerSchema.Type>, SqlError.SqlError>;
}

export const ListerRepository = Context.GenericTag<ListerRepository>("ListerRepository");

export const ListerRepositoryLive = Layer.effect(
  ListerRepository,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return {
      findByUserId: (userId) =>
        Effect.gen(function*() {
          return yield* sql<typeof ListerSchema.Type>`
            SELECT *
              FROM listers
             WHERE user_id=${userId}
         RETURNING *;
            `
            .pipe(
              Effect.map(rows => rows[0]),
              Effect.map(Option.fromNullable)
            )

        })
    } satisfies ListerRepository // needed otherwise email/password become untyped when using taperror
  }).pipe(
    Effect.tapError(error =>
      Effect.sync(() =>
        Effect.logError("Lister repository failed", { error })
      )
    )
  )
)
