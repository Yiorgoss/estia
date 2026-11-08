import { pageShell, primaryButtonClass } from "@/frontend/layout";

/*
 * The answer to a signed-out visitor on a page that needs a session. The header
 * shows every visitor the private links, so following one has to lead to a
 * prompt with a way forward rather than a bare 401 body.
 */
export const signInRequiredPage = pageShell(
  "Sign in required",
  `
    <h1 class="text-2xl font-semibold text-gray-900">Sign in required</h1>
    <p class="mt-3 text-sm text-gray-600">
      You need to be signed in to see your listings and manage them.
    </p>
    <p class="mt-6">
      <a href="/login" class="${primaryButtonClass}">Sign in</a>
    </p>`,
);
