import { GreekRegionCodes, ListingKind } from "@/db/schema/Listing";
import type { SavedSearch } from "@/db/schema/SavedSearch";
import { kindLabels, regionLabels } from "../listing-labels";
import { head } from "../head";
import { header } from "../header";
import { savedSearchesPanel, saveSearchForm } from "../saved-search";
import { emptySearchFormValues, type SearchFlagValue, type SearchFormValues } from "../search-form";
import { escapeHtml } from "@/utils";

const numberField = (
  name: string,
  label: string,
  placeholder: string,
  value: string,
  step = "any",
) => `
  <div>
    <label for="${name}" class="mb-1 block text-sm font-medium text-gray-700">${label}</label>
    <input
      id="${name}"
      name="${name}"
      type="number"
      min="0"
      step="${step}"
      placeholder="${placeholder}"
      ${value === "" ? "" : `value="${escapeHtml(value)}"`}
      class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  </div>`;

const selectField = (
  name: string,
  label: string,
  defaultLabel: string,
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  selected: string,
) => `
  <div>
    <label for="${name}" class="mb-1 block text-sm font-medium text-gray-700">${label}</label>
    <select
      id="${name}"
      name="${name}"
      class="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      <option value="">${defaultLabel}</option>
      ${options
        .map(
          (option) =>
            `<option value="${option.value}" ${option.value === selected ? "selected" : ""}>${option.label}</option>`,
        )
        .join("")}
    </select>
  </div>`;

const flagField = (name: string, label: string, selected: SearchFlagValue) =>
  selectField(
    name,
    label,
    "Any",
    [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ],
    selected,
  );

const regionOptions = GreekRegionCodes.map((code) => ({
  value: code,
  label: regionLabels[code],
}));

const kindOptions = ListingKind.literals.map((kind) => ({
  value: kind,
  label: kindLabels[kind],
}));

export interface SearchPageOptions {
  // The values a saved search fills in; an ordinary visit starts empty.
  readonly values?: SearchFormValues;
  // The results section's first request. A saved search hands it the stored
  // criteria, so the page opens on that search instead of the unfiltered feed.
  readonly resultsUrl?: string;
  // Present only for a signed-in caller: the saved-search list and the save
  // control are the account's own, and a visitor sees neither.
  readonly savedSearches?: ReadonlyArray<SavedSearch>;
  readonly savedError?: string;
  readonly appliedSavedSearchId?: number;
}

export const searchPage = (options: SearchPageOptions = {}) => {
  const values = options.values ?? emptySearchFormValues;
  const resultsUrl = options.resultsUrl ?? "/search/results";
  const saved =
    options.savedSearches === undefined
      ? ""
      : `${saveSearchForm()}
         ${savedSearchesPanel(options.savedSearches, {
           error: options.savedError,
           appliedId: options.appliedSavedSearchId,
         })}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${head}
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Find a listing</title>
</head>
<body class="min-h-lvh bg-gray-50">
  ${header}
  <main class="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
    <h1 class="text-2xl font-semibold text-gray-900">Find a listing</h1>
    <p class="mt-1 text-sm text-gray-600">
      Browse published listings by region, price, size, and what they allow.
    </p>

    <form
      id="search-form"
      hx-get="/search/results"
      hx-target="#results"
      hx-swap="innerHTML"
      hx-trigger="submit, change delay:200ms"
      class="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
    >
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        ${selectField("regionCode", "Region", "Any region", regionOptions, values.regionCode)}
        ${selectField("kind", "Kind", "Any kind", kindOptions, values.kind)}
        ${numberField("minPrice", "Min price (€)", "0", values.minPrice)}
        ${numberField("maxPrice", "Max price (€)", "2000", values.maxPrice)}
      </div>

      <div class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        ${numberField("minSizeSqm", "Min size (m²)", "0", values.minSizeSqm, "1")}
        ${numberField("maxSizeSqm", "Max size (m²)", "150", values.maxSizeSqm, "1")}
        <div>
          <label for="availableFrom" class="mb-1 block text-sm font-medium text-gray-700">
            Available from
          </label>
          <input
            id="availableFrom"
            name="availableFrom"
            type="date"
            ${values.availableFrom === "" ? "" : `value="${escapeHtml(values.availableFrom)}"`}
            class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <fieldset class="mt-4">
        <legend class="mb-1 block text-sm font-medium text-gray-700">Details</legend>
        <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          ${flagField("furnished", "Furnished", values.furnished)}
          ${flagField("ensuite", "Ensuite", values.ensuite)}
          ${flagField("smoking", "Smoking allowed", values.smoking)}
          ${flagField("pets", "Pets allowed", values.pets)}
        </div>
      </fieldset>

      <div class="mt-5 flex items-center gap-3">
        <button
          type="submit"
          class="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 [.htmx-request_&]:cursor-progress [.htmx-request_&]:opacity-60"
        >
          Search
        </button>
        <a
          href="/search"
          class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Reset
        </a>
      </div>
    </form>

    ${saved}

    <section
      id="results"
      hx-get="${escapeHtml(resultsUrl)}"
      hx-trigger="load"
      hx-swap="innerHTML"
      class="mt-8"
    ></section>
  </main>
</body>
</html>
`;
};
