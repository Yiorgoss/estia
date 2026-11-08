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
 * Both profiles are provisioned at registration, so a role switch is a flip
 * between two rows that already exist. An account created before that - or one
 * whose profile row went missing - gets the missing row opened from the user id
 * alone, which the nullable columns in 0006 allow, so no account is ever left
 * with a role that points at nothing. Admins and unassigned accounts hold no
 * profile to switch between, so they are refused rather than guessed at.
 */
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
  /*
   * Create the account and every profile it needs: one row per role, so no
   * account exists without a seeker and a lister profile. A profile that cannot
   * be opened takes the new account with it, so a failed registration leaves
   * nothing behind.
   */
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
    AdminRoleSwitchError | UnassignedRoleSwitchError | InternalError
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
            // switch between and no target role to infer. It is the role an
            // account created before registration provisioned both profiles
            // carries until that account picks one.
            case "user":
              return yield* Effect.fail(
                new UnassignedRoleSwitchError({
                  message: "This account has neither a seeker nor a lister profile yet.",
                }),
              );

            // Switching to listing: both profiles exist from registration
            // onward, so this is a plain flip. The profile is still asked for
            // first, and created if it is missing, so a legacy account never
            // gets a role pointing at a profile that does not exist.
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
            // along, and a later call can switch back.
            case "lister": {
              const existing = yield* listerRepo.findByUserId(id);
              if (Option.isNone(existing)) {
                return yield* listerRepo.createForUser(id);
              }

              // The seeking profile was provisioned at registration, so it is
              // normally already there and the flip is all that is left. Asking
              // for it anyway opens it for a legacy account, and answers with the
              // existing row for everyone else.
              const seeker = yield* seekerRepo.createForUser(id);
              yield* userRepo
                .updateRole(id, "seeker")
                .pipe(Effect.filterOrFail(Option.isSome, () => new InternalError()));
              return seeker;
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

          // A new account is born seeking: it has both profiles, so the stored
          // role only decides which of them `me` answers with, and one flip
          // moves the account to listing. Leaving it unassigned would strand a
          // brand new account on the guard that refuses to switch an account
          // with no profile to switch between.
          const user = yield* userRepo.insert({ email, password: hash, role: "seeker" }).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new InternalError()),
                onSome: Effect.succeed,
              }),
            ),
          );

          // The account row is written first because the profile rows point at
          // it, and the two profile rows follow. D1's atomic batch is only on the
          // D1-specific client, which these `SqlClient` repositories are not
          // written against, so a profile that cannot be opened removes the
          // account it just created - its profile rows cascade with it - and a
          // registration that reports a failure leaves nothing behind for the
          // retry to collide with.
          yield* Effect.gen(function* () {
            yield* seekerRepo.createForUser(user.id);
            yield* listerRepo.createForUser(user.id);
          }).pipe(Effect.onError(() => userRepo.deleteById(user.id).pipe(Effect.ignore)));

          return user;
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
