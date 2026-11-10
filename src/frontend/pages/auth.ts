import { escapeHtml } from "@/utils";
import { head } from "../head";
import { header } from "../header";

/*
 * Sign-in and registration are server-rendered forms: the browser posts the
 * fields back to the page's own URL and the route answers with a redirect to the
 * listing feed, or to the profile page after registering, or with this page
 * again carrying the reason it was rejected.
 *
 * They are not htmx forms. The `/api/auth` endpoints are a JSON API, and htmx
 * posts form-encoded bodies by default, so a page pointed at them cannot work;
 * the pages therefore talk to their own form routes, the same way the listing
 * pages do, so the JSON API only ever decodes JSON.
 *
 * Nothing here is user input except the address echoed back into a rejected
 * form, which is escaped.
 */

const labelClass = "mb-1 block text-sm font-medium text-gray-700";
const inputClass =
  "w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500";
const primaryButtonClass =
  "w-full rounded-md bg-blue-700 px-4 py-2 font-medium text-white hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2";
const errorBannerClass =
  "rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700";

export interface AuthPageState {
  // A rejected submit returns the page with the address still in the box.
  readonly email?: string | undefined;
  readonly message?: string | undefined;
}

const errorBanner = (message: string | undefined) =>
  message === undefined
    ? ""
    : `<p role="alert" class="${errorBannerClass}">${escapeHtml(message)}</p>`;

const emailField = (state: AuthPageState) => `
  <div>
    <label for="email" class="${labelClass}">Email</label>
    <input
      id="email"
      name="email"
      type="email"
      autocomplete="email"
      required
      value="${escapeHtml(state.email ?? "")}"
      class="${inputClass}"
    />
  </div>`;

// Passwords are never echoed back: a rejected form shows its reason and starts
// the password boxes empty.
const passwordField = (name: string, label: string, autocomplete: string) => `
  <div>
    <label for="${name}" class="${labelClass}">${label}</label>
    <input
      id="${name}"
      name="${name}"
      type="password"
      autocomplete="${autocomplete}"
      required
      class="${inputClass}"
    />
  </div>`;

const pageShell = (title: string, content: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  ${head}
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body class="min-h-lvh bg-gray-50">
  ${header}
  <main class="mx-auto w-full max-w-md px-4 py-12 sm:px-6">
    ${content}
  </main>
</body>
</html>
`;

export const loginPage = (state: AuthPageState = {}) =>
  pageShell(
    "Sign in",
    `
    <h1 class="text-2xl font-semibold text-gray-900">Sign in</h1>
    <p class="mt-1 text-sm text-gray-600">Sign in to post and manage your listings.</p>

    <form
      method="post"
      action="/login"
      class="mt-6 space-y-5 rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
    >
      ${errorBanner(state.message)}
      ${emailField(state)}
      ${passwordField("password", "Password", "current-password")}
      <button type="submit" class="${primaryButtonClass}">Sign in</button>
    </form>`,
  );

export const registerPage = (state: AuthPageState = {}) =>
  pageShell(
    "Create an account",
    `
    <h1 class="text-2xl font-semibold text-gray-900">Create an account</h1>
    <p class="mt-1 text-sm text-gray-600">An account lets you post and manage your listings.</p>

    <form
      method="post"
      action="/register"
      class="mt-6 space-y-5 rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
    >
      ${errorBanner(state.message)}
      ${emailField(state)}
      ${passwordField("password", "Password", "new-password")}
      ${passwordField("repeat_password", "Repeat password", "new-password")}
      <button type="submit" class="${primaryButtonClass}">Create account</button>
    </form>`,
  );
