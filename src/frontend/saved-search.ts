import type { SavedSearch } from "@/db/schema/SavedSearch";
import { escapeHtml } from "@/utils";

/*
 * The saved-search pieces around the results page. A saved search belongs to the
 * signed-in account, so none of this is rendered for a visitor: the page only
 * calls these when a session identified the caller.
 */

const inputClass =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500";

// The apply link is a full navigation: the saved criteria become the form's
// values and the results section's first request, so the page a person lands on
// is the same page they would have reached by filling the form in by hand.
export const savedSearchHref = (id: number): string => `/search?saved=${id}`;

/*
 * The exact criteria a saved search stores, as the results route's query. Prices
 * travel in minor units because that is what the route filters on; the form's
 * euros are only a presentation. A false flag is set too, because it is a real
 * filter, not an absent one.
 */
export const savedSearchResultsHref = (saved: SavedSearch): string => {
  const params = new URLSearchParams();
  if (saved.kind != null) params.set("kind", saved.kind);
  if (saved.regionCode != null) params.set("regionCode", saved.regionCode);
  if (saved.minPriceMinor != null) params.set("minPriceMinor", String(saved.minPriceMinor));
  if (saved.maxPriceMinor != null) params.set("maxPriceMinor", String(saved.maxPriceMinor));
  if (saved.minSizeSqm != null) params.set("minSizeSqm", String(saved.minSizeSqm));
  if (saved.maxSizeSqm != null) params.set("maxSizeSqm", String(saved.maxSizeSqm));
  if (saved.furnished != null) params.set("furnished", saved.furnished ? "true" : "false");
  if (saved.ensuite != null) params.set("ensuite", saved.ensuite ? "true" : "false");
  if (saved.smoking != null) params.set("smoking", saved.smoking ? "true" : "false");
  if (saved.pets != null) params.set("pets", saved.pets ? "true" : "false");
  if (saved.availableFrom != null) params.set("availableFrom", saved.availableFrom.toISOString());

  const search = params.toString();
  return search === "" ? "/search/results" : `/search/results?${search}`;
};

const nameInput = (value: string, outOfBand: boolean) => `
  <input
    id="saved-search-name"
    name="name"
    type="text"
    value="${escapeHtml(value)}"
    maxlength="120"
    placeholder="Name (optional)"
    class="${inputClass}"
    ${outOfBand ? 'hx-swap-oob="true"' : ""}
  />`;

const notice = (message: string, tone: "saved" | "error") => `
  <p class="mt-3 rounded-md ${tone === "error" ? "border border-red-200 bg-red-50 text-red-700" : "border border-green-200 bg-green-50 text-green-800"} px-3 py-2 text-sm">
    ${escapeHtml(message)}
  </p>`;

/*
 * The control on the results page. It lives in the results fragment, so it is
 * re-rendered with every search, and it pulls the current criteria from the form
 * with `hx-include`. Saving targets the saved-search list rather than the results,
 * because the results did not change - only the list did.
 *
 * The name box is optional: the service names an unnamed search after its own
 * criteria. It is identified by id so a successful save can clear it with an
 * out-of-band swap.
 */
export const saveSearchForm = () => `
  <form
    hx-post="/search/saved"
    hx-target="#saved-searches"
    hx-swap="outerHTML"
    hx-include="#search-form"
    class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
  >
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-0 flex-1">
        <label for="saved-search-name" class="mb-1 block text-sm font-medium text-gray-700">
          Save this search
        </label>
        ${nameInput("", false)}
      </div>
      <button
        type="submit"
        class="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 [.htmx-request_&]:cursor-progress [.htmx-request_&]:opacity-60"
      >
        Save search
      </button>
    </div>
    <p class="mt-1 text-xs text-gray-500">
      Leave the name blank to save a summary of the filters.
    </p>
  </form>`;

// The clear after a save, as an out-of-band swap on the same id the form boxes
// use. It travels with the list response so the save control is ready for the
// next search without a script.
export const clearedNameInput = () => nameInput("", true);

export interface SavedSearchesPanelOptions {
  readonly notice?: string | undefined;
  readonly error?: string | undefined;
  readonly appliedId?: number | undefined;
}

const savedSearchRow = (saved: SavedSearch, appliedId: number | undefined) => `
  <li class="flex flex-wrap items-center justify-between gap-2 py-2">
    <a
      href="${savedSearchHref(saved.id)}"
      class="min-w-0 break-words text-sm font-medium text-blue-700 hover:text-blue-800"
      ${saved.id === appliedId ? 'aria-current="page"' : ""}
    >
      ${escapeHtml(saved.name)}
    </a>
    <form
      method="post"
      action="/search/saved/${saved.id}/delete"
      hx-post="/search/saved/${saved.id}/delete"
      hx-target="#saved-searches"
      hx-swap="outerHTML"
      class="shrink-0"
    >
      <button
        type="submit"
        class="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1"
      >
        Delete
      </button>
    </form>
  </li>`;

/*
 * The caller's saved searches, rendered as one section. The section carries the
 * id htmx targets, and the element is replaced whole on a save or a delete, so a
 * request never has to patch a row in place.
 */
export const savedSearchesPanel = (
  items: ReadonlyArray<SavedSearch>,
  options: SavedSearchesPanelOptions = {},
) => `
  <section
    id="saved-searches"
    aria-live="polite"
    class="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-base font-semibold text-gray-900">Saved searches</h2>
      <p class="text-xs text-gray-500">Run one again from here.</p>
    </div>

    ${options.notice === undefined ? "" : notice(options.notice, "saved")}
    ${options.error === undefined ? "" : notice(options.error, "error")}

    ${
      items.length > 0
        ? `<ul class="mt-3 divide-y divide-gray-100">
             ${items.map((item) => savedSearchRow(item, options.appliedId)).join("")}
           </ul>`
        : options.error === undefined
          ? `<p class="mt-3 text-sm text-gray-600">
             No saved searches yet. Search the listings, then save the criteria from the results.
           </p>`
          : ""
    }
  </section>`;
