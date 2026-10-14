import { assert, layer } from "@effect/vitest"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { HasherService } from "@/services/hasher.service"
import { UserService } from "@/services/user.service"
import { UserRepository } from "@/repo/user.repo"
import { UserId } from "@/db/schema/brands"
import { TestServicesLive } from "../support/services"
import { insertLister, insertSeeker, insertUser } from "../support/seed"

const userId = (value: string) => Schema.decodeSync(UserId)(value)

layer(TestServicesLive, { concurrent: false })("UserService", (it) => {
  it.effect("registerUser stores a hashed password and returns the user", () =>
    Effect.gen(function*() {
      const service = yield* UserService
      const hasher = yield* HasherService
      const repo = yield* UserRepository

      const registered = yield* service.registerUser(
        { email: "register@test.local", password: "s3cret-password" },
        "vitest",
      )

      assert.strictEqual(registered.email, "register@test.local")
      assert.strictEqual(registered.role, "user")
      assert.notStrictEqual(registered.passwordHash, "s3cret-password")

      // The stored hash verifies against the original password.
      const accepted = yield* hasher.verifyPassword("s3cret-password", registered.passwordHash)
      assert.isTrue(accepted)

      const stored = yield* repo.findByEmail("register@test.local")
      assert.isTrue(Option.isSome(stored))
      assert.strictEqual(Option.getOrThrow(stored).id, registered.id)
    }))

  it.effect("registerUser fails with UserAlreadyExistsError for a duplicate email", () =>
    Effect.gen(function*() {
      const service = yield* UserService
      const credentials = { email: "duplicate-user@test.local", password: "pw" }

      yield* service.registerUser(credentials, "vitest")

      const error = yield* Effect.flip(service.registerUser(credentials, "vitest"))
      assert.strictEqual(error._tag, "UserAlreadyExistsError")
    }))

  it.effect("switchRoles to seeker updates the role and returns the seeker profile", () =>
    Effect.gen(function*() {
      const service = yield* UserService
      yield* insertUser("u-switch-seeker", "switch-seeker@test.local")
      yield* insertSeeker("u-switch-seeker", { name: "Asha", bio: "Quiet flatmate" })

      const profile = yield* service.switchRoles(userId("u-switch-seeker"), "seeker")

      assert.strictEqual(profile.name, "Asha")
      assert.isTrue("bio" in profile)
      assert.isFalse("ownership" in profile)

      const repo = yield* UserRepository
      const stored = Option.getOrThrow(
        yield* repo.findById(userId("u-switch-seeker")),
      )
      assert.strictEqual(stored.role, "seeker")
    }))

  it.effect("switchRoles to lister returns the lister profile", () =>
    Effect.gen(function*() {
      const service = yield* UserService
      yield* insertUser("u-switch-lister", "switch-lister@test.local")
      yield* insertLister(1, "u-switch-lister", { name: "Lee", ownership: "leaseholder" })

      const profile = yield* service.switchRoles(userId("u-switch-lister"), "lister")

      assert.isTrue("ownership" in profile)
      if ("ownership" in profile) {
        assert.strictEqual(profile.name, "Lee")
        assert.strictEqual(profile.ownership, "leaseholder")
      }
      assert.isFalse("bio" in profile)
    }))

  it.effect("switchRoles dies when the target profile is missing", () =>
    Effect.gen(function*() {
      const service = yield* UserService
      yield* insertUser("u-switch-no-profile", "switch-no-profile@test.local")

      const exit = yield* Effect.exit(
        service.switchRoles(userId("u-switch-no-profile"), "seeker"),
      )
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        assert.isTrue(Cause.hasDies(exit.cause))
      }
    }))

  it.effect("switchRoles dies for an unknown user", () =>
    Effect.gen(function*() {
      const service = yield* UserService

      const exit = yield* Effect.exit(
        service.switchRoles(userId("u-switch-missing"), "seeker"),
      )
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        assert.isTrue(Cause.hasDies(exit.cause))
      }
    }))

  it.effect("switchRoles dies when asked to become an admin or an unprofiled user", () =>
    Effect.gen(function*() {
      const service = yield* UserService
      yield* insertUser("u-switch-die", "switch-die@test.local")

      const admin = yield* Effect.exit(
        service.switchRoles(userId("u-switch-die"), "admin"),
      )
      assert.isTrue(Exit.isFailure(admin))
      if (Exit.isFailure(admin)) {
        assert.isTrue(Cause.hasDies(admin.cause))
      }

      const plainUser = yield* Effect.exit(
        service.switchRoles(userId("u-switch-die"), "user"),
      )
      assert.isTrue(Exit.isFailure(plainUser))
      if (Exit.isFailure(plainUser)) {
        assert.isTrue(Cause.hasDies(plainUser.cause))
      }
    }))
})
