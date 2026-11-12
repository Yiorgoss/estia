import type { SavedSearch, SavedSearchCriteria } from "@/db/schema/SavedSearch";
import { summarizeSavedSearch } from "@/services/saved-search.service";
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
 * The control next to the saved-search list. It lives on the search page itself,
 * outside the results fragment a search refresh swaps, so a typed name survives
 * that refresh. The current criteria come from the form with `hx-include`.
 * Saving targets the saved-search list rather than the results, because the
 * results did not change - only the list did.
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
    class="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
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

/*
 * Where the panel is rendered. The list and its controls are the same on both
 * pages; what differs is the hint over an empty list and the page a form without
 * htmx returns to, because a search is saved on the search page and read on the
 * listing profile, which has no filters of its own.
 */
export type SavedSearchesPlace = "search" | "profile";

export interface SavedSearchesPanelOptions {
  readonly notice?: string | undefined;
  readonly error?: string | undefined;
  readonly appliedId?: number | undefined;
  readonly place?: SavedSearchesPlace | undefined;
}

// The stored criteria as the summarizer wants them: a null column is the stored
// "any", which the summary reads as a criterion the search did not narrow on.
const criteriaFromSavedSearch = (saved: SavedSearch): SavedSearchCriteria => ({
  kind: saved.kind ?? undefined,
  regionCode: saved.regionCode ?? undefined,
  minPriceMinor: saved.minPriceMinor ?? undefined,
  maxPriceMinor: saved.maxPriceMinor ?? undefined,
  minSizeSqm: saved.minSizeSqm ?? undefined,
  maxSizeSqm: saved.maxSizeSqm ?? undefined,
  furnished: saved.furnished ?? undefined,
  ensuite: saved.ensuite ?? undefined,
  smoking: saved.smoking ?? undefined,
  pets: saved.pets ?? undefined,
  availableFrom: saved.availableFrom ?? undefined,
});

const runLinkClass =
  "rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1";

/*
 * One saved search as a person reads it back: the name it was saved under and,
 * when that name is not already the criteria summary, the criteria themselves.
 * The service names an unnamed search after its criteria, so the summary line is
 * left out there instead of saying the same thing twice.
 */
const savedSearchRow = (
  saved: SavedSearch,
  appliedId: number | undefined,
  place: SavedSearchesPlace,
) => {
  const summary = summarizeSavedSearch(criteriaFromSavedSearch(saved));
  return `
  <li class="flex flex-wrap items-start justify-between gap-2 py-2">
    <div class="min-w-0">
      <p class="break-words text-sm font-medium text-gray-900">${escapeHtml(saved.name)}</p>
      ${
        summary === saved.name
          ? ""
          : `<p class="mt-0.5 break-words text-xs text-gray-600">${escapeHtml(summary)}</p>`
      }
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <a
        href="${savedSearchHref(saved.id)}"
        class="${runLinkClass}"
        ${saved.id === appliedId ? 'aria-current="page"' : ""}
      >
        Run
      </a>
      <form
        method="post"
        action="/search/saved/${saved.id}/delete"
        hx-post="/search/saved/${saved.id}/delete"
        hx-target="#saved-searches"
        hx-swap="outerHTML"
        class="shrink-0"
      >
        ${place === "profile" ? '<input type="hidden" name="place" value="profile" />' : ""}
        <button
          type="submit"
          class="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1"
        >
          Delete
        </button>
      </form>
    </div>
  </li>`;
};

/*
 * What the panel says around the list. The search page is where a search is
 * saved and it has the filters above the list; the listing profile is where the
 * list is read and has none, so its empty state says where a search comes from
 * instead of pointing at a form that is not there.
 */
const panelCopy = (place: SavedSearchesPlace) =>
  place === "profile"
    ? {
        hint: "Searches you saved from the listings page.",
        empty:
          "No saved searches yet. Save a search from the listings page and it will appear here.",
      }
    : {
        hint: "Run one again from here.",
        empty: "No saved searches yet. Set the filters above, then save them.",
      };

/*
 * The caller's saved searches, rendered as one section. The section carries the
 * id htmx targets, and the element is replaced whole on a save or a delete, so a
 * request never has to patch a row in place.
 */
export const savedSearchesPanel = (
  items: ReadonlyArray<SavedSearch>,
  options: SavedSearchesPanelOptions = {},
) => {
  const place = options.place ?? "search";
  const copy = panelCopy(place);
  return `
  <section
    id="saved-searches"
    aria-live="polite"
    class="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-base font-semibold text-gray-900">Saved searches</h2>
      <p class="text-xs text-gray-500">${copy.hint}</p>
    </div>

    ${options.notice === undefined ? "" : notice(options.notice, "saved")}
    ${options.error === undefined ? "" : notice(options.error, "error")}

    ${
      items.length > 0
        ? `<ul class="mt-3 divide-y divide-gray-100">
             ${items.map((item) => savedSearchRow(item, options.appliedId, place)).join("")}
           </ul>`
        : options.error === undefined
          ? `<p class="mt-3 text-sm text-gray-600">
             ${copy.empty}
           </p>`
          : ""
    }
  </section>`;
};
