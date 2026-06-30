import { Effect, Schema } from "effect"
import { ServerApi } from ".."
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"

export const GreetingsGroup = HttpApiGroup.make("Greetings").add(
  HttpApiEndpoint.get("/")`/`.addSuccess(Schema.String)
)
export const GreetingsLive = HttpApiBuilder.group(ServerApi, "Greetings", (handlers) =>
  handlers.handle("/", () => Effect.succeed("Hello, World!"))
)


