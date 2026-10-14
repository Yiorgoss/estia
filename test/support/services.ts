import { ConfigProvider, Layer } from "effect"
import { HasherServiceLive } from "@/services/hasher.service"
import { JWTServiceLive } from "@/services/jwt.service"
import { AuthServiceLive } from "@/services/auth.service"
import { RefreshTokenServiceLive } from "@/services/refresh-token.service"
import { UserServiceLive } from "@/services/user.service"
import { ListerRepositoryLive } from "@/repo/lister.repo"
import { RefreshTokenRepositoryLive } from "@/repo/refresh-token.repo"
import { SeekerRepositoryLive } from "@/repo/seeker.repo"
import { UserRepositoryLive } from "@/repo/user.repo"
import { TestSqlLive } from "./sql"

// `node:crypto`'s `crypto.getRandomValues` returns a plain `Uint8Array`, and
// `refresh-token.service.ts` calls the `Uint8Array.prototype.toHex` method that
// the Cloudflare Workers runtime provides. Node 22 (the vitest runtime) predates
// that method, so install the same semantics for the service tests without
// changing production code. `src/utils/index.ts` contains the identical helper.
if (typeof Uint8Array.prototype.toHex !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    configurable: true,
    writable: true,
    value(this: Uint8Array) {
      return Array.from(this)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
    },
  })
}

// Config the JWT service reads. The values mirror `.dev.vars` so signed tokens
// carry the same issuer/audience shape the app produces.
export const TEST_DOMAIN = "http://localhost:8799"
export const TEST_JWT_SECRET = "test-secret"

export const TestConfigLive = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    DOMAIN: TEST_DOMAIN,
    JWT_SECRET: TEST_JWT_SECRET,
  }),
)

export const TestRepositoriesLive = Layer.mergeAll(
  UserRepositoryLive,
  RefreshTokenRepositoryLive,
  SeekerRepositoryLive,
  ListerRepositoryLive,
)

export const TestInfraLive = Layer.mergeAll(
  HasherServiceLive,
  JWTServiceLive.pipe(Layer.provide(TestConfigLive)),
)

export const TestDomainServicesLive = Layer.mergeAll(
  UserServiceLive,
  RefreshTokenServiceLive,
).pipe(
  Layer.provide(TestRepositoriesLive),
  Layer.provide(TestInfraLive),
)

export const TestAuthServiceLive = AuthServiceLive.pipe(
  Layer.provide(TestDomainServicesLive),
  Layer.provide(TestRepositoriesLive),
  Layer.provide(TestInfraLive),
)

// Mirrors `AppServicesLive` from `src/api/index.ts`: every service plus the
// repositories, with only `SqlClient` left to provide. Merging `TestSqlLive`
// in through `provideMerge` shares one in-memory database across the suite and
// keeps the raw `SqlClient` available for seeding assertions.
export const TestServicesLive = Layer.mergeAll(
  TestAuthServiceLive,
  TestDomainServicesLive,
  TestInfraLive,
  TestRepositoriesLive,
).pipe(Layer.provideMerge(TestSqlLive))
