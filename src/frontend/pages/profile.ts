import type { ProfileFormValues } from "@/frontend/profile-form";
import { isSeekerProfileComplete } from "@/frontend/profile-form";
import type { EditableProfileRole } from "@/db/schema/Profile";
import type { SavedSearch } from "@/db/schema/SavedSearch";
import type { SenderIdentity } from "@/services/enquiry.service";
import { senderIdentityPreview } from "@/frontend/enquiry-identity";
import {
  errorBanner,
  pageShell,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/frontend/layout";
import { savedSearchesPanel } from "@/frontend/saved-search";
import { escapeHtml } from "@/utils";

/*
 * The profile page is a server-rendered form: the browser posts the fields back
 * here, the route runs the same user service the JSON API uses, and a failure is
 * answered with this page again carrying the reason. Every value echoed back is
 * user input, so it is escaped.
 *
 * A seeking profile is incomplete until it names a person of a known age and
 * gender, and the page says so at the top rather than letting a blank form look
 * finished.
 */

const labelClass = "mb-1 block text-sm font-medium text-gray-700";
const inputClass =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500";
const selectClass =
  "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500";
const hintClass = "mt-1 text-xs text-gray-500";

const genderOptions = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "NB", label: "Non-binary" },
] as const;

const ownershipOptions = [
  { value: "owner", label: "Owner - the place is mine" },
  { value: "leaseholder", label: "Leaseholder - I rent the place" },
] as const;

const roleTitles: Record<EditableProfileRole, string> = {
  seeker: "Seeking profile",
  lister: "Listing profile",
};

const roleNotes: Record<EditableProfileRole, string> = {
  seeker: "How you introduce yourself when you answer a listing.",
  lister: "How you appear next to the listings you post.",
};

const savedBanner = (saved: boolean) =>
  saved
    ? `<p class="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800" role="status">Your profile was saved.</p>`
    : "";

// A switch that had to open the account's missing current row before it could
// flip has not changed the role yet. Saying so keeps the first click honest and
// leaves the switch in place for the click that actually moves roles.
const completedBanner = (completed: boolean) =>
  completed
    ? `<p class="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800" role="status">This profile was completed. Use the switch again to open the other one.</p>`
    : "";

const incompleteNotice = () => `
  <div class="rounded-lg border border-amber-200 bg-amber-50 p-4" role="status">
    <p class="text-sm font-medium text-amber-900">Your seeking profile is incomplete</p>
    <p class="mt-1 text-sm text-amber-800">
      Add your name, date of birth and gender so people know who they are talking to.
    </p>
  </div>`;

const textInput = (
  name: string,
  options: {
    readonly value: string;
    readonly placeholder?: string;
    readonly required?: boolean;
    readonly autocomplete?: string;
  },
) => `<input
      id="${name}"
      name="${name}"
      type="text"
      ${options.autocomplete === undefined ? "" : `autocomplete="${options.autocomplete}"`}
      value="${escapeHtml(options.value)}"
      ${options.placeholder === undefined ? "" : `placeholder="${escapeHtml(options.placeholder)}"`}
      ${options.required === true ? "required" : ""}
      class="${inputClass}"
    />`;

const dateInput = (value: string, max: string) => `<input
      id="dateOfBirth"
      name="dateOfBirth"
      type="date"
      value="${escapeHtml(value)}"
      max="${max}"
      required
      class="${inputClass}"
    />`;

const select = (
  name: string,
  label: string,
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  value: string,
  placeholder: string,
) => `
  <div>
    <label for="${name}" class="${labelClass}">${label}</label>
    <select id="${name}" name="${name}" required class="${selectClass}">
      <option value="" ${value === "" ? "selected" : ""}>${placeholder}</option>
      ${options
        .map(
          (option) =>
            `<option value="${option.value}" ${option.value === value ? "selected" : ""}>${option.label}</option>`,
        )
        .join("")}
    </select>
  </div>`;

const checkbox = (name: string, label: string, checked: boolean) => `
  <label class="flex items-center gap-2 text-sm text-gray-700">
    <input
      type="checkbox"
      name="${name}"
      value="true"
      ${checked ? "checked" : ""}
      class="size-4 accent-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
    />
    ${label}
  </label>`;

// Today in UTC is the latest day a date of birth can be. It is a browser hint
// only: the service refuses a future date whatever the input allows.
const todayValue = (): string => new Date().toISOString().slice(0, 10);

// The one contact field both profiles carry: free text, because it is whatever
// the person chose to publish. Neither form requires it; the identity notice
// above the fields says what an enquiry would carry right now.
const contactField = (value: string) => `
  <div class="mt-4">
    <label for="contact" class="${labelClass}">Contact details</label>
    ${textInput("contact", {
      value,
      placeholder: "Email, phone, or however you want to be reached",
      autocomplete: "off",
    })}
  </div>`;

const seekerFields = (values: ProfileFormValues) => `
  <div>
    <label for="name" class="${labelClass}">Name</label>
    ${textInput("name", {
      value: values.name,
      placeholder: "Your name",
      required: true,
      autocomplete: "name",
    })}
  </div>

  <div class="mt-4 grid gap-4 sm:grid-cols-2">
    <div>
      <label for="dateOfBirth" class="${labelClass}">Date of birth</label>
      ${dateInput(values.dateOfBirth, todayValue())}
    </div>
    ${select("gender", "Gender", genderOptions, values.gender, "Choose your gender")}
  </div>

  <div class="mt-4">
    <label for="bio" class="${labelClass}">About you</label>
    <textarea
      id="bio"
      name="bio"
      rows="4"
      placeholder="A sentence or two about yourself. Optional."
      class="${inputClass}"
    >${escapeHtml(values.bio)}</textarea>
    <p class="${hintClass}">Optional. Shown to people whose listings you answer.</p>
  </div>

  ${contactField(values.contact)}

  <fieldset class="mt-4">
    <legend class="${labelClass}">Habits</legend>
    <div class="grid gap-2 sm:grid-cols-2">
      ${checkbox("smoking", "I smoke", values.smoking)}
      ${checkbox("pets", "I have pets", values.pets)}
    </div>
  </fieldset>`;

const listerFields = (values: ProfileFormValues) => `
  <div>
    <label for="name" class="${labelClass}">Display name</label>
    ${textInput("name", {
      value: values.name,
      placeholder: "The name shown on your listings",
      autocomplete: "name",
    })}
    <p class="${hintClass}">Optional. Leave it empty to post without a name.</p>
  </div>

  <div class="mt-4">
    ${select("ownership", "Ownership", ownershipOptions, values.ownership, "Choose one")}
    <p class="${hintClass}">
      An owner holds the property. A leaseholder rents it and is subletting.
    </p>
  </div>

  ${contactField(values.contact)}`;

const switchControl = (role: EditableProfileRole) => {
  const label = role === "seeker" ? "Switch to my listing profile" : "Switch to my seeking profile";
  return `<form method="post" action="/profile/switch">
        <button type="submit" class="${secondaryButtonClass}">${label}</button>
      </form>`;
};

/*
 * The way out of a session, on the page a signed-in person already visits. It is
 * a form post rather than a link because signing out writes: the route revokes
 * the refresh token and clears both session cookies, then redirects to the
 * sign-in page.
 *
 * This button ends the one session, which is what most visits want, so the
 * all-devices action lives in its own card below instead of next to it.
 */
const logoutControl = () => `<form method="post" action="/api/auth/logout">
        <button type="submit" class="${secondaryButtonClass}">Log out</button>
      </form>`;

// The wider action gets its own colour so it does not read as the everyday
// log-out beside it.
const dangerButtonClass =
  "rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2";

/*
 * The wider way out. It is separate from the log-out control above because it
 * ends sessions the person is not looking at, and the copy says what each one
 * does. The last paragraph records what this cannot reach: the app has no
 * revocation list for the short-lived access tokens it has already handed out,
 * so a session that is open right now can keep working until its access token
 * expires - within an hour. Nothing emails the other devices either.
 */
const signOutEverywhereControl =
  () => `<section class="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <h2 class="text-base font-semibold text-gray-900">Sign out of all devices</h2>
      <p class="mt-1 text-sm text-gray-600">
        Log out ends only this session; your other devices stay signed in.
        Signing out of all devices ends every session on this account - in other
        browsers, on phones and computers, and the earlier sign-ins this account
        left behind. Each of them has to sign in again.
      </p>
      <form method="post" action="/api/auth/logout-all" class="mt-4">
        <button type="submit" class="${dangerButtonClass}">Sign out of all devices</button>
      </form>
      <p class="mt-3 text-xs text-gray-500">
        A session that is open right now can keep working for up to an hour,
        until the credentials it was handed expire. No email is sent when a
        device is signed out.
      </p>
    </section>`;

export interface ProfilePageState {
  readonly role: EditableProfileRole;
  readonly values: ProfileFormValues;
  readonly error?: string | undefined;
  readonly saved?: boolean | undefined;
  readonly completed?: boolean | undefined;
  // The listing profile also carries the account's saved searches. Both are
  // absent on a page with no place for the list: the seeking profile, the choice
  // page, and the pages that explain why there is no profile to show.
  readonly savedSearches?: ReadonlyArray<SavedSearch> | undefined;
  readonly savedSearchesError?: string | undefined;
  // What this account's enquiries carry right now, resolved by the same service
  // the send uses, so the form shows the record instead of describing the rule.
  readonly enquiryIdentity?: SenderIdentity | undefined;
}

/*
 * The saved-search list on the listing profile. It is the search page's own
 * section rendered in its profile place, so the two pages cannot drift, and a
 * failed read is passed on as its reason so the section never reads as "none".
 */
const savedSearchesSection = (state: ProfilePageState) =>
  state.savedSearches === undefined && state.savedSearchesError === undefined
    ? ""
    : savedSearchesPanel(state.savedSearches ?? [], {
        place: "profile",
        error: state.savedSearchesError,
      });

const enquiryIdentityNotice = (identity: SenderIdentity | undefined) =>
  identity === undefined
    ? ""
    : `<p class="mt-4 rounded-md bg-gray-50 p-3 text-sm text-gray-600">${senderIdentityPreview(identity)}</p>`;

export const profilePage = (state: ProfilePageState) => {
  const incomplete = state.role === "seeker" && !isSeekerProfileComplete(state.values);

  return pageShell(
    "Your profile",
    `
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold text-gray-900">Your profile</h1>
        <p class="mt-1 text-sm text-gray-600">
          Tell people who you are. You can switch between a seeking and a listing
          profile; this page edits the one your account is using now.
        </p>
      </div>
      ${logoutControl()}
    </div>

    <div class="mt-4 space-y-4">
      ${savedBanner(state.saved === true)}
      ${completedBanner(state.completed === true)}
      ${errorBanner(state.error)}
      ${incomplete ? incompleteNotice() : ""}
    </div>

    <section class="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold text-gray-900">${roleTitles[state.role]}</h2>
          <p class="mt-1 text-sm text-gray-600">${roleNotes[state.role]}</p>
        </div>
        ${switchControl(state.role)}
      </div>

      <form method="post" action="/profile" class="mt-6">
        ${enquiryIdentityNotice(state.enquiryIdentity)}
        ${state.role === "seeker" ? seekerFields(state.values) : listerFields(state.values)}

        <div class="mt-6 flex flex-wrap items-center gap-3">
          <button type="submit" class="${primaryButtonClass}">Save profile</button>
          <a href="/search" class="${secondaryButtonClass}">Back to listings</a>
        </div>
      </form>
    </section>

    ${savedSearchesSection(state)}

    ${signOutEverywhereControl()}`,
  );
};

// Why there is no profile form to show, for the cases that have none: an admin
// holds no profile, and a rejected or cross-site write is told why too.
export const profileUnavailablePage = (title: string, message: string) =>
  pageShell(
    title,
    `
    <h1 class="text-2xl font-semibold text-gray-900">${escapeHtml(title)}</h1>
    <p class="mt-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
      ${escapeHtml(message)}
    </p>
    <p class="mt-6 flex flex-wrap items-center gap-3">
      <a href="/search" class="${secondaryButtonClass}">Back to listings</a>
      <a href="/login" class="${secondaryButtonClass}">Sign in with another account</a>
    </p>`,
  );

// An account left unassigned by an older registration has no profile yet, so
// the page asks which one it wants. Each choice is a switch that adopts that
// profile and assigns the role, after which the ordinary form is shown.
export const profileChoicePage = (error?: string | undefined) =>
  pageShell(
    "Your profile",
    `
    <h1 class="text-2xl font-semibold text-gray-900">Your profile</h1>
    <p class="mt-1 text-sm text-gray-600">
      Tell people who you are. Choose the profile you want to fill in; you can
      switch to the other one at any time.
    </p>

    <div class="mt-4 flex justify-end">${logoutControl()}</div>

    <div class="mt-4">${errorBanner(error)}</div>

    <section class="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <h2 class="text-base font-semibold text-gray-900">Choose a profile</h2>
      <p class="mt-1 text-sm text-gray-600">
        A seeking profile is for answering listings. A listing profile is for
        posting them.
      </p>

      <div class="mt-6 flex flex-wrap items-center gap-3">
        <form method="post" action="/profile/switch">
          <input type="hidden" name="role" value="seeker" />
          <button type="submit" class="${primaryButtonClass}">Fill in my seeking profile</button>
        </form>
        <form method="post" action="/profile/switch">
          <input type="hidden" name="role" value="lister" />
          <button type="submit" class="${secondaryButtonClass}">Fill in my listing profile</button>
        </form>
      </div>
    </section>

    ${signOutEverywhereControl()}`,
  );
