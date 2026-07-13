import { PublicApi } from "@/api/public";
import { User } from "@/db/schema/User";
import { JWT } from "@/services/jwt";
import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";


export const PublicApiLive = HttpApiBuilder.group(
  PublicApi,
  'auth',
  (handlers) =>
    handlers
      .handle('login', (req) => Effect.gen(function*() {
        //validate user
        const { email, password } = req.payload
        console.log({ email, password })
        // return {
        //   id: 1,
        //   name: "a",
        //   age: 1,
        //   email: "a",
        //   created_at: new Date(),
        //   updated_at: new Date()
        // }
      })
      )
  // .handle("testUser", (req) =>
  //   Effect.gen(function*() {
  //     const { sign, verify } = yield* JWT
  //     const token = yield* sign({ xx: "userr-123w" })
  //     const orig = yield* verify(token)
  //     return {
  //       token,
  //       decode: orig
  //     }
  //   })
  // )
)

