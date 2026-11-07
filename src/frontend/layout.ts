import { head } from "@/frontend/head";
import { header } from "@/frontend/header";
import { escapeHtml } from "@/utils";

/*
 * The shell every page shares: one column, the site header, and the pieces a
 * rejected action needs to explain itself. The create/edit pages, the mine page,
 * and the sign-in prompt render through it, so those pages cannot drift apart.
 */

export const primaryButtonClass =
  "rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2";

export const secondaryButtonClass =
  "rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50";

export const errorBanner = (message: string | undefined) =>
  message === undefined
    ? ""
    : `<p class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">${escapeHtml(message)}</p>`;

export const pageShell = (title: string, content: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  ${head}
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body class="min-h-lvh bg-gray-50">
  ${header}
  <main class="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
    ${content}
  </main>
</body>
</html>
`;
