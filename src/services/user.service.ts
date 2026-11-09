import { UserCredentials, UserSchema } from "@/db/schema/User";
import { UserRepository } from "@/repos/user.repo";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { HasherService } from "./hasher.service";
import { ListerSchema } from "@/db/schema/Lister";
import { UserId } from "@/db/schema/brands";
import { SeekerSchema } from "@/db/schema/Seeker";
import { SeekerRepository } from "@/repos/seeker.repo";
import { ListerRepository } from "@/repos/lister.repo";
import { editableProfileRole, type EditableProfileRole, type ProfileInput } from "@/db/schema/Profile";

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
 * with a role that points at nothing. An account left unassigned by an older
 * registration adopts either profile by naming it; an admin holds no profile to
 * switch between, so it is refused rather than guessed at.
 */
export class AdminRoleSwitchError extends Schema.TaggedError<AdminRoleSwitchError>()(
  "AdminRoleSwitchError",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/*
 * An unassigned account has no current profile to flip away from, so a switch
 * from it has to name the profile it adopts. Without that choice there is
 * nothing to infer, which is a refusal about the request, not a server failure.
 */
export class UnassignedRoleSwitchError extends Schema.TaggedError<UnassignedRoleSwitchError>()(
  "UnassignedRoleSwitchError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/*
 * Only an admin is left without a profile: an unassigned account picks one on
 * its first save or switch. That is a refusal about the account's state, not a
 * server failure, so it keeps its own 409.
 */
export class ProfileUnavailableError extends Schema.TaggedError<ProfileUnavailableError>()(
  "ProfileUnavailableError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

// A payload that cannot be applied to the profile the account holds now - the
// other role's shape, or an impossible value like a birth date in the future.
export class ProfileValidationError extends Schema.TaggedError<ProfileValidationError>()(
  "ProfileValidationError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export type UserProfile = typeof SeekerSchema.Type | typeof ListerSchema.Type;

// A profile together with the role it belongs to. The role is the answer, not
// the request, because an unassigned account's save or choice assigns it.
export interface ProfileDetails {
  readonly role: EditableProfileRole;
  readonly profile: UserProfile;
}

export interface UserService {
  /*
   * Create the account and every profile it needs: one row per role, so no
   * account exists without a seeker and a lister profile. A profile that cannot
   * be opened removes the new account again, and that delete is best effort: a
   * failed cleanup is logged, so a retry after a reported failure may still
   * collide with the account row.
   */
  registerUser: (
    credentials: typeof UserCredentials.Type,
    userAgent: string,
  ) => Effect.Effect<typeof UserSchema.Type, UserAlreadyExistsError | InternalError>;
  /*
   * Flip the stored role and answer with the profile that role now has. The
   * stored role is the starting point, never a role carried by the request. An
   * unassigned account has no role to flip away from, so it adopts the target
   * it names; an assigned account flips to the other profile unless it names a
   * target too. The stored role and its profile row agree after the call
   * whichever side was missing.
   */
  switchRoles: (
    id: typeof UserId.Type,
    target: EditableProfileRole | undefined,
  ) => Effect.Effect<
    ProfileDetails,
    AdminRoleSwitchError | UnassignedRoleSwitchError | InternalError
  >;
  /*
   * The caller's own profile for the role they hold now. A profile row that does
   * not exist yet is `None` rather than an invented one, so a legacy account can
   * still open the form and save into it. An unassigned account reads as `None`:
   * it has no current role, and the page asks it to pick one.
   */
  readProfile: (
    user: typeof UserSchema.Type,
  ) => Effect.Effect<Option.Option<UserProfile>, ProfileUnavailableError | InternalError>;
  /*
   * Save the details the caller filled in, creating the row if it is missing, so
   * a legacy or partially provisioned account is repaired by the same call that
   * saves a normal one. An assigned account's role comes from the stored row; an
   * unassigned one adopts the role its payload describes, which is how a legacy
   * account picks a side of the market. A payload for the other role is refused
   * instead of being partially applied.
   */
  saveProfile: (
    user: typeof UserSchema.Type,
    input: ProfileInput,
  ) => Effect.Effect<
    ProfileDetails,
    ProfileUnavailableError | ProfileValidationError | InternalError
  >;
}

export const UserService = Context.Service<UserService>("UserService");

// The refusal an admin gets: the one account with no profile to read or edit.
export const noProfileMessage =
  "An admin account has no seeking or listing profile to edit.";

// A saved bio is either a value the person typed or nothing: a box they emptied
// is an absence, not an empty string in the database.
const bioOf = (bio: string | null | undefined): string | null => {
  const trimmed = bio?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

// A birth date in the future is not a birth date. This is the one rule the
// boundary cannot state, because it depends on the moment of the save.
const beforeToday = (dateOfBirth: Date): Effect.Effect<Date, ProfileValidationError> =>
  dateOfBirth.getTime() > Date.now()
    ? Effect.fail(
        new ProfileValidationError({ message: "A date of birth cannot be in the future." }),
      )
    : Effect.succeed(dateOfBirth);

export const UserServiceLive = Layer.effect(
  UserService,
  Effect.gen(function* () {
    const userRepo = yield* UserRepository;
    const hasherService = yield* HasherService;
    const listerRepo = yield* ListerRepository;
    const seekerRepo = yield* SeekerRepository;

    // Open the profile row a role points at, or answer with the one already
    // there. `createForUser` is idempotent, so a retry or a second tab is safe.
    const openProfile = (role: EditableProfileRole, id: typeof UserId.Type) =>
      role === "seeker" ? seekerRepo.createForUser(id) : listerRepo.createForUser(id);

    return {
      readProfile: (user) =>
        Effect.gen(function* () {
          if (user.role === "user") return Option.none<UserProfile>();

          const role = editableProfileRole(user.role);
          if (role === undefined) {
            return yield* Effect.fail(new ProfileUnavailableError({ message: noProfileMessage }));
          }
          return role === "seeker"
            ? yield* seekerRepo.findByUserId(user.id)
            : yield* listerRepo.findByUserId(user.id);
        }).pipe(Effect.catchTags({ SqlError: () => Effect.fail(new InternalError()) })),
      saveProfile: (user, input) =>
        Effect.gen(function* () {
          const stored = editableProfileRole(user.role);
          if (stored === undefined && user.role === "admin") {
            return yield* Effect.fail(new ProfileUnavailableError({ message: noProfileMessage }));
          }

          // The two payloads are told apart by the field only one of them has, so
          // an account with a role keeps its own shape and a client that sends
          // the other role's form is refused rather than having every field it
          // happened to send applied to the wrong profile. An unassigned account
          // has no shape to keep, so the payload is the choice it makes.
          const role: EditableProfileRole = "ownership" in input ? "lister" : "seeker";
          if (stored !== undefined && stored !== role) {
            return yield* Effect.fail(
              new ProfileValidationError({
                message:
                  stored === "seeker"
                    ? "This account is seeking, so it has no listing details to save."
                    : "This account is listing, so it has no seeking details to save.",
              }),
            );
          }

          const profile = "ownership" in input
            ? yield* listerRepo.upsertForUser(user.id, input)
            : yield* Effect.gen(function* () {
                yield* beforeToday(input.dateOfBirth);
                return yield* seekerRepo.upsertForUser(user.id, {
                  ...input,
                  bio: bioOf(input.bio),
                });
              });

          if (user.role === "user") {
            yield* userRepo
              .updateRole(user.id, role)
              .pipe(Effect.filterOrFail(Option.isSome, () => new InternalError()));
          }

          return { role, profile };
        }).pipe(Effect.catchTags({ SqlError: () => Effect.fail(new InternalError()) })),
      switchRoles: (id, target) =>
        Effect.gen(function* () {
          const user = yield* userRepo
            .findById(id)
            .pipe(Effect.mapError(() => new InternalError()));
          if (Option.isNone(user)) {
            return yield* Effect.fail(new InternalError());
          }

          const stored = editableProfileRole(user.value.role);
          if (stored === undefined) {
            if (user.value.role === "admin") {
              return yield* Effect.fail(
                new AdminRoleSwitchError({
                  message: "An admin account cannot switch roles.",
                }),
              );
            }

            // The unassigned role is the state an account created before
            // registration provisioned both profiles carries until it picks a
            // side of the market. The target is that choice; without one there
            // is nothing to infer, so the request is refused.
            if (target === undefined) {
              return yield* Effect.fail(
                new UnassignedRoleSwitchError({
                  message: "Choose whether this account is seeking or listing.",
                }),
              );
            }

            const profile = yield* openProfile(target, id);
            yield* userRepo
              .updateRole(id, target)
              .pipe(Effect.filterOrFail(Option.isSome, () => new InternalError()));
            return { role: target, profile };
          }

          // A stored lister role with no lister row is the half-applied state an
          // earlier switch left behind. A switch that names no role repairs that
          // row and answers with it rather than moving the account on before it
          // holds a profile again; a later call can switch normally.
          if (stored === "lister" && target === undefined) {
            const existing = yield* listerRepo.findByUserId(id);
            if (Option.isNone(existing)) {
              const profile = yield* listerRepo.createForUser(id);
              return { role: "lister" as const, profile };
            }
          }

          // An assigned account flips to the other profile, or to the one it
          // names. Asking for the row it already holds is the same idempotent
          // heal, so the stored role never points at nothing.
          const next = target ?? (stored === "seeker" ? "lister" : "seeker");
          const profile = yield* openProfile(next, id);
          if (next !== stored) {
            yield* userRepo
              .updateRole(id, next)
              .pipe(Effect.filterOrFail(Option.isSome, () => new InternalError()));
          }
          return { role: next, profile };
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
          // account it just created, its profile rows cascading with it. That
          // delete is best effort: a cleanup that fails is logged rather than
          // swallowed, so a retry after a reported failure can still collide with
          // the account row.
          yield* Effect.gen(function* () {
            yield* seekerRepo.createForUser(user.id);
            yield* listerRepo.createForUser(user.id);
          }).pipe(
            Effect.onError(() =>
              userRepo.deleteById(user.id).pipe(
                Effect.tapError((error) =>
                  Effect.logError("Registration rollback failed", { error }),
                ),
                Effect.ignore,
              ),
            ),
          );

          return user;
          // const accessToken = yield* jwtService.signUser(user)
          // const refreshToken = yield* refreshTokenService.issueToken(user.id, userAgent)
          // return { accessToken, refreshToken }
        }).pipe(
          Effect.tapError((e) => Effect.logError("Signup failed", { error: e })),
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
