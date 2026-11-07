import { Config, Context, Effect, Layer } from "effect";

/*
 * The origin the app is served from, in the form a browser serialises into its
 * `Origin` and `Referer` headers. `DOMAIN` is the deployed URL; a route cannot
 * read it directly because the config provider is only in scope while the
 * service layers are built, so the parsed origin is read once here and handed
 * to the request-scoped layers the same way the other services are.
 */
export class AppOrigin extends Context.Service<AppOrigin, { readonly origin: string }>()(
  "AppOrigin",
  {
    make: Effect.gen(function* () {
      const domain = yield* Config.String("DOMAIN");
      return { origin: new URL(domain).origin };
    }),
  },
) {}

export const AppOriginLive = Layer.effect(AppOrigin, AppOrigin.make);
