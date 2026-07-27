import { PrivateApi } from "@/api/private";
import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";


export const PrivateApiLive = HttpApiBuilder.group(
  PrivateApi,
  'private',
  (handlers) =>
    handlers
      .handle("private-test", (req) =>
        Effect.gen(function*() {
          const response = yield* HttpServerResponse.html(
            ` <div class="bg-red-200">HIHI PRI~VTE</div>
              `
          )
          return response
        })
      )
)
