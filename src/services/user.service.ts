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
 * A role switch is only honest when the target profile exists afterwards, so a
 * switch whose target can neither be found nor opened is refused rather than
 * leaving the account with a role that points at nothing. Both profiles are
 * provisioned at registration, so this is the last resort rather than the normal
 * answer: a stored role whose profile row is missing heals instead. Admins and
 * unassigned accounts hold no profile to switch between, so they are refused
 * rather than guessed at.
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
  /*
   * Create the account and every profile it needs: one row per role, in a fixed
   * order, so no account exists without a seeker and a lister profile.
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
            // first, and created if it is missing, so a legacy account - or a
            // half-applied registration - never gets a role pointing at a
            // profile that does not exist.
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
              // normally already there and the flip is all that is left. A
              // legacy account that predates that gets a blank profile opened
              // from the user id alone, which the nullable columns in 0006
              // allow. An account whose profile can neither be found nor opened
              // is refused and keeps its stored role.
              const seeker = yield* seekerRepo.findByUserId(id).pipe(
                Effect.flatMap(
                  Option.match({
                    onSome: (found) => Effect.succeed(Option.some(found)),
                    onNone: () => seekerRepo.createForUser(id),
                  }),
                ),
              );
              if (Option.isNone(seeker)) {
                return yield* Effect.fail(
                  new SeekerProfileRequiredError({
                    message: "A seeker profile could not be opened for this account.",
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

          // D1 has no interactive transactions, so the profiles are opened as
          // two single statements in a fixed order instead of pretending the
          // registration is atomic. A failure between them leaves an account
          // that the self-heal path in `switchRoles` repairs on its next
          // request; a duplicate email, the failure worth reporting, happens
          // before any of this.
          yield* seekerRepo
            .createForUser(user.id)
            .pipe(Effect.filterOrFail(Option.isSome, () => new InternalError()));
          yield* listerRepo.createForUser(user.id);

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
