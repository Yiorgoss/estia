import type { ProfileFormValues } from "@/frontend/profile-form";
import { isSeekerProfileComplete } from "@/frontend/profile-form";
import type { EditableProfileRole } from "@/db/schema/Profile";
import {
  errorBanner,
  pageShell,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/frontend/layout";
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
  </div>`;

const switchControl = (role: EditableProfileRole) => {
  const label = role === "seeker" ? "Switch to my listing profile" : "Switch to my seeking profile";
  return `<form method="post" action="/profile/switch">
        <button type="submit" class="${secondaryButtonClass}">${label}</button>
      </form>`;
};

export interface ProfilePageState {
  readonly role: EditableProfileRole;
  readonly values: ProfileFormValues;
  readonly error?: string | undefined;
  readonly saved?: boolean | undefined;
}

export const profilePage = (state: ProfilePageState) => {
  const incomplete = state.role === "seeker" && !isSeekerProfileComplete(state.values);

  return pageShell(
    "Your profile",
    `
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold text-gray-900">Your profile</h1>
        <p class="mt-1 text-sm text-gray-600">
          Tell people who you are. Both profiles already belong to your account;
          this page edits the one your account is using now.
        </p>
      </div>
    </div>

    <div class="mt-4 space-y-4">
      ${savedBanner(state.saved === true)}
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
        ${state.role === "seeker" ? seekerFields(state.values) : listerFields(state.values)}

        <div class="mt-6 flex flex-wrap items-center gap-3">
          <button type="submit" class="${primaryButtonClass}">Save profile</button>
          <a href="/search" class="${secondaryButtonClass}">Back to listings</a>
        </div>
      </form>
    </section>`,
  );
};

// An account whose role holds no profile - an admin, or one left unassigned by
// an older registration - has nothing to edit, and is told so instead of being
// shown a form that cannot be saved.
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
