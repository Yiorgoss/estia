import { editableProfileRole } from "@/db/schema/Profile";
import { callerUser } from "@/handlers/private/caller";
import { crossSiteFormMessage, isSameOriginWrite } from "@/handlers/same-origin";
import {
  decodeListerProfileForm,
  decodeSeekerProfileForm,
  profileFormValues,
  profileFormValuesFrom,
} from "@/frontend/profile-form";
import { profilePage, profileUnavailablePage } from "@/frontend/pages/profile";
import { UnauthorizedError } from "@/services/auth.service";
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
import { Effect, Option } from "effect";

/*
 * The profile page, on the private router so `AuthMiddleware` gates it: a
 * signed-out visitor gets the sign-in prompt, not a bare 401. The submits are
 * answered with a page, so a rejected form shows its reason with the values the
 * person typed still in place, and a save redirects to the same page so a
 * refresh cannot repeat the write.
 *
 * The role a form belongs to is always the account's stored role. Nothing in the
 * request selects it, and the switch control below uses the same service the
 * JSON endpoint does, so the role rules stay in one place.
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
      return { title: "This account has no profile yet", message: error.message, status: 409 };
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
  respond(profileUnavailablePage("This account has no profile yet", noProfileMessage), 409);

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

const savedFlag = (params: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>) =>
  params["saved"] === "1";

const getProfilePage = HttpRouter.route("GET", "/profile", (request) =>
  Effect.gen(function* () {
    const user = yield* callerUser(request);
    const role = editableProfileRole(user.role);
    if (role === undefined) return unavailableResponse();

    const userService = yield* UserService;
    const profile = yield* userService.readProfile(user);
    const params = yield* HttpServerRequest.ParsedSearchParams;

    return respond(
      profilePage({
        role,
        values: profileFormValuesFrom(Option.getOrNull(profile)),
        saved: savedFlag(params),
      }),
      200,
    );
  }).pipe(Effect.catch((error: ProfilePageError) => Effect.succeed(errorResponse(error)))),
);

const saveProfile = HttpRouter.route("POST", "/profile", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) return crossSiteResponse();

    const user = yield* callerUser(request);
    const role = editableProfileRole(user.role);
    if (role === undefined) return unavailableResponse();

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
      Effect.catch((error: ProfilePageError) => {
        const { message, status } = describeError(error);
        return Effect.succeed(respond(profilePage({ role, values, error: message }), status));
      }),
    );
  }).pipe(Effect.catch((error: ProfilePageError) => Effect.succeed(errorResponse(error)))),
);

/*
 * The switch is a form post with no fields: the direction is the stored role's
 * opposite, exactly as the JSON endpoint decides it. Landing back on the profile
 * page means the person sees the other form, pre-filled from its own row.
 */
const switchRole = HttpRouter.route("POST", "/profile/switch", (request) =>
  Effect.gen(function* () {
    if (!isSameOriginWrite(request)) return crossSiteResponse();

    const user = yield* callerUser(request);
    const userService = yield* UserService;
    yield* userService.switchRoles(user.id);
    return seeOther("/profile");
  }).pipe(Effect.catch((error: ProfilePageError) => Effect.succeed(errorResponse(error)))),
);

// Exported as routes rather than a layer so the private router can register
// them next to its other pages under one auth middleware.
export const ProfilePageRoutes = [getProfilePage, saveProfile, switchRole];
