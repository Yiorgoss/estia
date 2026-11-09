import { PrivateApi } from "@/api/private";
import { callerUser } from "@/handlers/private/caller";
import { ListerRepository } from "@/repos/lister.repo";
import { SeekerRepository } from "@/repos/seeker.repo";
import { InternalError, UserProfile, UserService } from "@/services/user.service";
import { HttpApiBuilder } from "effect/http-api";
import { Effect, Option } from "effect";

/*
 * The signed-in account's own view. Both handlers start from the stored user, so
 * the answer always describes the account as it is now: the role comes from the
 * row, the profile is whatever that role points at, and a profile that does not
 * exist yet is a null rather than a made-up error.
 */
export const UserHandler = HttpApiBuilder.group(PrivateApi, "user-group", (handlers) =>
  handlers
    .handle("me", ({ request }) =>
      Effect.gen(function* () {
        const user = yield* callerUser(request);

        const listerRepo = yield* ListerRepository;
        const seekerRepo = yield* SeekerRepository;
        const userProfile: Option.Option<UserProfile> =
          user.role === "lister"
            ? yield* listerRepo.findByUserId(user.id)
            : yield* seekerRepo.findByUserId(user.id);

        // Only what the wire carries: the stored id and role, never the account
        // row itself (which also holds the password hash).
        return {
          user: { id: user.id, role: user.role },
          userProfile: Option.getOrNull(userProfile),
        };
      }).pipe(Effect.catchTags({ SqlError: () => Effect.fail(new InternalError()) })),
    )
    .handle("profile", ({ request }) =>
      Effect.gen(function* () {
        const user = yield* callerUser(request);
        const userService = yield* UserService;
        const profile = yield* userService.readProfile(user);
        return { role: user.role, profile: Option.getOrNull(profile) };
      }),
    )
    .handle("save-profile", ({ payload, request }) =>
      Effect.gen(function* () {
        // The role is read from the stored account, so a caller cannot save a
        // listing profile by saying it is one: the payload is matched to the role
        // the account already holds.
        const user = yield* callerUser(request);
        const userService = yield* UserService;
        const profile = yield* userService.saveProfile(user, payload);
        return { role: user.role, profile };
      }),
    )
    .handle("change-role", ({ request }) =>
      Effect.gen(function* () {
        const user = yield* callerUser(request);
        const userService = yield* UserService;
        const newProfile = yield* userService.switchRoles(user.id);
        return { newProfile };
      }),
    ),
);
