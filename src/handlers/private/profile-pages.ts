import { editableProfileRole } from "@/db/schema/Profile";
import type { EditableProfileRole } from "@/db/schema/Profile";
import type { UserId } from "@/db/schema/brands";
import type { SavedSearch } from "@/db/schema/SavedSearch";
import { callerUser } from "@/handlers/private/caller";
import { crossSiteFormMessage, isSameOriginWrite } from "@/handlers/same-origin";
import {
  decodeListerProfileForm,
  decodeSeekerProfileForm,
  profileFormValues,
  profileFormValuesFrom,
} from "@/frontend/profile-form";
import { profileChoicePage, profilePage, profileUnavailablePage } from "@/frontend/pages/profile";
import { UnauthorizedError } from "@/services/auth.service";
import { SavedSearchService } from "@/services/saved-search.service";
import {
  AdminRoleSwitchError,
  InternalError,
  ProfileUnavailableError,
  ProfileValidationError,
  UnassignedRoleSwitchError,
  UserService,
  noProfileMessage,
} from "@/services/user.service";
import { HttpRouter, HttpServerRequest, HttpServerResponse, UrlParams } from "effect/http";
import { Effect, Option, Result } from "effect";

/*
 * The profile page, on the private router so `AuthMiddleware` gates it: a
 * signed-out visitor gets the sign-in prompt, not a bare 401. The submits are
 * answered with a page, so a rejected form shows its reason with the values the
 * person typed still in place, and a save redirects to the same page so a
 * refresh cannot repeat the write.
 *
 * The role a form belongs to is always the account's stored role. Nothing in the
 * request selects it; the only choice is the switch an unassigned account makes,
 * and it uses the same service the JSON endpoint does, so the role rules stay in
 * one place.
 */

type ProfilePageError =
  | ProfileUnavailableError
  | ProfileValidationError
  | AdminRoleSwitchError
  | UnassignedRoleSwitchError
  | UnauthorizedError
  | InternalError;

interface PageError {
  readonly title: string;
  readonly message: string;
  readonly status: number;
}

const describeError = (error: ProfilePageError): PageError => {
  switch (error._tag) {
    case "ProfileUnavailableError":
      return { title: "An admin account has no profile", message: error.message, status: 409 };
    case "ProfileValidationError":
      return { title: "That profile could not be saved", message: error.message, status: 400 };
    case "AdminRoleSwitchError":
    case "UnassignedRoleSwitchError":
      return { title: "That profile cannot be opened", message: error.message, status: 409 };
    case "UnauthorizedError":
      return {
        title: "Sign in required",
        message: "Sign in to see and edit your profile.",
        status: 401,
      };
    case "InternalError":
      return {
        title: "Something went wrong",
        message: "Your profile could not be loaded or saved just now. Please try again.",
        status: 500,
      };
  }
};

const respond = (body: string, status: number): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(body, { status, contentType: "text/html" });

const seeOther = (location: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.redirect(location, { status: 303 });

const errorResponse = (error: ProfilePageError): HttpServerResponse.HttpServerResponse => {
  const { title, message, status } = describeError(error);
  return respond(profileUnavailablePage(title, message), status);
};

const unavailableResponse = (): HttpServerResponse.HttpServerResponse =>
  respond(profileUnavailablePage("An admin account has no profile", noProfileMessage), 409);

const choiceResponse = (status: number, error?: string): HttpServerResponse.HttpServerResponse =>
  respond(profileChoicePage(error), status);

// These routes change a profile, and their forms are simple requests, so the
// browser will post one from another site with the session attached. The shared
// origin check refuses that before anything is written.
const crossSiteResponse = (): HttpServerResponse.HttpServerResponse =>
  respond(
    profileUnavailablePage("That form did not come from this site", crossSiteFormMessage),
    403,
  );

const readForm = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(Effect.orDie(request.urlParamsBody), UrlParams.toRecord);

interface SavedSearchesState {
  readonly savedSearches?: ReadonlyArray<SavedSearch> | undefined;
  readonly savedSearchesError?: string | undefined;
}

const savedSearchesLoadError = "Your saved searches could not be loaded just now.";

/*
 * The listing profile shows the account's saved searches. It reads them through
 * the same service and repository as the search page, so the two pages list the
 * same rows. A failed read is passed on as its reason rather than as an empty
 * list, because an empty list would tell the account it has saved none.
 */
const savedSearchesFor = (
  ownerId: typeof UserId.Type,
): Effect.Effect<SavedSearchesState, never, SavedSearchService> =>
  Effect.gen(function* () {
    const savedSearchService = yield* SavedSearchService;
    const listed = yield* Effect.result(savedSearchService.list(ownerId));
    if (Result.isFailure(listed)) {
      yield* Effect.logError("Saved searches could not be read for the profile page", {
        error: listed.failure,
      });
      return { savedSearchesError: savedSearchesLoadError };
    }
    return { savedSearches: listed.success };
  });

const savedFlag = (params: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>) =>
  params["saved"] === "1";

const completedFlag = (
  params: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
) => params["completed"] === "1";

// The profile an unassigned account chooses. It is the only switch that carries
// a direction, because there is no current role to flip away from.
const roleTarget = (
  value: string | ReadonlyArray<string> | undefined,
): EditableProfileRole | undefined => {
  const role = typeof value === "string" ? value : value?.[0];
  return role === "seeker" || role === "lister" ? role : undefined;
};

const getProfilePage = HttpRouter.route("GET", "/profile", () =>
  Effect.gen(function* () {
    const user = yield* callerUser;
    const role = editableProfileRole(user.role);
    if (role === undefined) {
      return user.role === "user" ? choiceResponse(200) : unavailableResponse();
    }

    const userService = yield* UserService;
    const profile = yield* userService.readProfile(user);
    const params = yield* HttpServerRequest.ParsedSearchParams;
    // Only the listing profile carries the saved-search section; the seeking
    // profile has no place for it and is unchanged.
    const savedSearches = role === "lister" ? yield* savedSearchesFor(user.id) : {};

    return respond(
      profilePage({
        role,
        values: profileFormValuesFrom(Option.getOrNull(profile)),
        saved: savedFlag(params),
        completed: completedFlag(params),
        ...savedSearches,
      }),
      200,
    );
  }).pipe(Effect.catch((error: ProfilePageError) => Effect.succeed(errorResponse(error)))),
);

const saveProfile = HttpRouter.route("POST", "/profile", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) return crossSiteResponse();

    const user = yield* callerUser;
    const role = editableProfileRole(user.role);
    if (role === undefined) {
      return user.role === "user"
        ? choiceResponse(400, "Choose the profile you want to fill in first.")
        : unavailableResponse();
    }

    const params = yield* readForm(request);
    const values = profileFormValues(params);
    const decoded =
      role === "seeker" ? decodeSeekerProfileForm(params) : decodeListerProfileForm(params);
    if (!decoded.ok) {
      return respond(profilePage({ role, values, error: decoded.message }), 400);
    }

    const userService = yield* UserService;
    return yield* userService.saveProfile(user, decoded.input).pipe(
      Effect.map(() => seeOther("/profile?saved=1")),
      Effect.catch((error: ProfilePageError) =>
        Effect.gen(function* () {
          const { message, status } = describeError(error);
          // A rejected submit is answered with the whole page, so the listing
          // profile keeps the saved-search section it was showing.
          const savedSearches = role === "lister" ? yield* savedSearchesFor(user.id) : {};
          return respond(profilePage({ role, values, error: message, ...savedSearches }), status);
        }),
      ),
    );
  }).pipe(Effect.catch((error: ProfilePageError) => Effect.succeed(errorResponse(error)))),
);

/*
 * The switch is a form post: an assigned account flips to its other profile,
 * exactly as the JSON endpoint decides it, while an unassigned account sends the
 * profile it chooses. Landing back on the profile page means the person sees the
 * other form, pre-filled from its own row. When the switch only opened the
 * account's missing current row, the page says so and keeps the control, so the
 * first click is not a silent no-op.
 */
const switchRole = HttpRouter.route("POST", "/profile/switch", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) return crossSiteResponse();

    const user = yield* callerUser;
    const params = yield* readForm(request);
    const userService = yield* UserService;
    const switched = yield* userService.switchRoles(user.id, roleTarget(params["role"]));
    return seeOther(switched.role === user.role ? "/profile?completed=1" : "/profile");
  }).pipe(Effect.catch((error: ProfilePageError) => Effect.succeed(errorResponse(error)))),
);

// Exported as routes rather than a layer so the private router can register
// them next to its other pages under one auth middleware.
export const ProfilePageRoutes = [getProfilePage, saveProfile, switchRole];
