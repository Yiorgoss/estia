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
 * lister profile needs nothing but the user id, so a stored lister role without
 * a row can be repaired and switching to listing can provision one. A seeker
 * profile needs a name, a date of birth, and a gender, which a payload-less
 * switch does not carry, so that switch is refused instead of leaving the
 * account with a role that points at nothing. Admins and unassigned accounts
 * hold no profile to switch between, so they are refused rather than guessed at.
 */
export class SeekerProfileRequiredError extends Schema.TaggedError<SeekerProfileRequiredError>()(
  "SeekerProfileRequiredError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class AdminRoleSwitchError extends Schema.TaggedError<AdminRoleSwitchError>()(
  "AdminRoleSwitchError",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class UnassignedRoleSwitchError extends Schema.TaggedError<UnassignedRoleSwitchError>()(
  "UnassignedRoleSwitchError",
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
   * stored role is the starting point, never a role carried by the request, and
   * the stored role and its profile row agree after the call whichever side was
   * missing.
   */
  switchRoles: (
    id: typeof UserId.Type,
  ) => Effect.Effect<
    UserProfile,
    SeekerProfileRequiredError | AdminRoleSwitchError | UnassignedRoleSwitchError | InternalError
  >;
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

          switch (user.value.role) {
            case "admin":
              return yield* Effect.fail(
                new AdminRoleSwitchError({
                  message: "An admin account cannot switch roles.",
                }),
              );

            // The unassigned role holds no profile, so there is nothing to
            // switch between and no target role to infer.
            case "user":
              return yield* Effect.fail(
                new UnassignedRoleSwitchError({
                  message: "This account has neither a seeker nor a lister profile yet.",
                }),
              );

            // Switching to listing: the profile is opened from the user id
            // alone, and the row is created first so the role never points at a
            // missing profile.
            case "seeker": {
              const lister = yield* listerRepo.createForUser(id);
              yield* userRepo
                .updateRole(id, "lister")
                .pipe(Effect.filterOrFail(Option.isSome, () => new InternalError()));
              return lister;
            }

            // Switching to seeking. A stored lister role with no lister row is
            // the half-applied state an earlier switch left behind, so that row
            // is opened first and answered with; the account was a lister all
            // along, and the next call can switch once a seeker profile exists.
            case "lister": {
              const existing = yield* listerRepo.findByUserId(id);
              if (Option.isNone(existing)) {
                return yield* listerRepo.createForUser(id);
              }

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
            }
          }
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
