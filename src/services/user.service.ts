import { UserCredentials, UserSchema } from "@/db/schema/User";
import { UserRepository } from "@/repos/user.repo";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { HasherService } from "./hasher.service";
import { ListerSchema } from "@/db/schema/Lister";
import { UserId } from "@/db/schema/brands";
import { SeekerSchema } from "@/db/schema/Seeker";
import { SeekerRepository } from "@/repos/seeker.repo";
import { ListerRepository } from "@/repos/lister.repo";

export class UserAlreadyExistsError extends Schema.TaggedError<UserAlreadyExistsError>()(
  "UserAlreadyExistsError",
  { cause: Schema.String },
  { httpApiStatus: 409 },
) {}

export class UserNotFoundError extends Schema.TaggedError<UserNotFoundError>()(
  "UserNotFoundError",
  { cause: Schema.String },
) {}

export class InternalError extends Schema.TaggedError<InternalError>()("InternalError", {}) {}

/*
 * A role switch is only honest when the target profile exists afterwards. A
 * lister profile needs nothing but the user id, so switching to listing can
 * provision it. A seeker profile needs a name, a date of birth, and a gender,
 * which a payload-less switch does not carry, so the switch is refused instead
 * of leaving the account with a role that points at nothing.
 */
export class SeekerProfileRequiredError extends Schema.TaggedError<SeekerProfileRequiredError>()(
  "SeekerProfileRequiredError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export type UserProfile = typeof SeekerSchema.Type | typeof ListerSchema.Type;

export interface UserService {
  registerUser: (
    credentials: typeof UserCredentials.Type,
    userAgent: string,
  ) => Effect.Effect<typeof UserSchema.Type, UserAlreadyExistsError | InternalError>;
  /*
   * Flip the stored role and answer with the profile that role now has. The
   * stored role is the starting point, never a role carried by the request.
   */
  switchRoles: (
    id: typeof UserId.Type,
  ) => Effect.Effect<UserProfile, SeekerProfileRequiredError | InternalError>;
}

export const UserService = Context.Service<UserService>("UserService");

export const UserServiceLive = Layer.effect(
  UserService,
  Effect.gen(function* () {
    const userRepo = yield* UserRepository;
    const hasherService = yield* HasherService;
    const listerRepo = yield* ListerRepository;
    const seekerRepo = yield* SeekerRepository;

    return {
      switchRoles: (id) =>
        Effect.gen(function* () {
          const user = yield* userRepo
            .findById(id)
            .pipe(Effect.mapError(() => new InternalError()));
          if (Option.isNone(user)) {
            return yield* Effect.fail(new InternalError());
          }

          // Switching to listing: the profile is either there already or can be
          // opened from the user id alone. The row is created first and the role
          // is written second, so the role never points at a missing profile.
          if (user.value.role !== "lister") {
            const existing = yield* listerRepo.findByUserId(id);
            const lister = Option.isSome(existing)
              ? existing.value
              : yield* listerRepo.createForUser(id);
            yield* userRepo
              .updateRole(id, "lister")
              .pipe(Effect.filterOrFail(Option.isSome, () => new InternalError()));
            return lister;
          }

          // Switching to seeking: the profile cannot be invented from a
          // payload-less request, so refuse before touching anything.
          const seeker = yield* seekerRepo.findByUserId(id);
          if (Option.isNone(seeker)) {
            return yield* Effect.fail(
              new SeekerProfileRequiredError({
                message: "A seeker profile has to be completed first.",
              }),
            );
          }
          yield* userRepo
            .updateRole(id, "seeker")
            .pipe(Effect.filterOrFail(Option.isSome, () => new InternalError()));
          return seeker.value;
        }).pipe(Effect.catchTags({ SqlError: () => Effect.fail(new InternalError()) })),
      registerUser: ({ email, password }) =>
        Effect.gen(function* () {
          yield* userRepo
            .findByEmail(email)
            .pipe(
              Effect.filterOrFail(
                Option.isNone,
                () => new UserAlreadyExistsError({ cause: "User Exists" }),
              ),
            );

          const hash = yield* hasherService.hashPassword(password);
          return yield* userRepo.insert({ email, password: hash }).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new InternalError()),
                onSome: Effect.succeed,
              }),
            ),
          );
          // const accessToken = yield* jwtService.signUser(user)
          // const refreshToken = yield* refreshTokenService.issueToken(user.id, userAgent)
          // return { accessToken, refreshToken }
        }).pipe(
          Effect.tapError((e) => Effect.logError(`Signup Failed - ${e.cause}`)),
          Effect.catchTags({
            UserAlreadyExistsError: (e) => Effect.fail(e),
            HashError: () => Effect.fail(new InternalError()),
            SqlError: () => Effect.fail(new InternalError()),
            // JWTSigningError: () => Effect.fail(new InternalError()),
          }),
        ),
    };
  }),
);
