import { SavedSearchId, UserId } from "@/db/schema/brands";
import { SavedSearchSchema } from "@/db/schema/SavedSearch";
import { searchPage } from "@/frontend/pages/search";
import {
  clearedNameInput,
  savedSearchResultsHref,
  savedSearchesPanel,
  saveSearchForm,
} from "@/frontend/saved-search";
import { searchFormValuesFromSavedSearch } from "@/frontend/search-form";
import { searchResults } from "@/frontend/search-results";
import { ListingPage } from "@/db/schema/Listing";
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

const savedSearch = (overrides: Record<string, unknown> = {}) =>
  Schema.decodeSync(SavedSearchSchema)({
    id: Schema.decodeSync(SavedSearchId)(7),
    userId: Schema.decodeSync(UserId)("u-saved-search"),
    name: "Balcony rooms in Attica",
    query: "balcony",
    kind: "room",
    regionCode: "attica",
    minPriceMinor: 40_000,
    maxPriceMinor: 120_050,
    minSizeSqm: 20,
    maxSizeSqm: 50,
    furnished: true,
    ensuite: false,
    smoking: null,
    pets: null,
    availableFrom: Date.UTC(2026, 2, 1),
    createdAt: Date.UTC(2026, 0, 1),
    ...overrides,
  });

const emptyPage: typeof ListingPage.Type = { items: [], nextCursor: null };

describe("searchPage", () => {
  it("renders no saved-search UI for a visitor", () => {
    const html = searchPage();

    assert.notInclude(html, 'id="saved-searches"');
    assert.notInclude(html, 'hx-post="/search/saved"');
    assert.include(html, 'hx-get="/search/results"');
    assert.include(html, 'name="query"');
  });

  it("renders the saved-search list for a signed-in caller", () => {
    const html = searchPage({ savedSearches: [savedSearch()] });

    assert.include(html, 'id="saved-searches"');
    assert.include(html, "Balcony rooms in Attica");
    assert.include(html, 'href="/search?saved=7"');
    assert.include(html, 'action="/search/saved/7/delete"');
  });

  it("pre-fills the form and the results request from an applied saved search", () => {
    const saved = savedSearch();
    const html = searchPage({
      savedSearches: [saved],
      values: searchFormValuesFromSavedSearch(saved),
      resultsUrl: savedSearchResultsHref(saved),
      appliedSavedSearchId: saved.id,
    });

    assert.include(html, 'value="balcony"');
    assert.include(html, '<option value="attica" selected>Attica</option>');
    assert.include(html, 'value="400"');
    assert.include(html, 'value="1200.5"');
    assert.include(html, 'value="2026-03-01"');
    assert.include(html, "<option value=\"true\" selected>Yes</option>");
    assert.include(html, "<option value=\"false\" selected>No</option>");
    assert.include(html, 'aria-current="page"');
    assert.include(html, "query=balcony");
    assert.include(html, "regionCode=attica");
    assert.include(html, "hx-get=\"/search/results?");
  });

  it("keeps a negative flag expressible when the form is reopened", () => {
    const saved = savedSearch({ furnished: null, ensuite: null, smoking: null, pets: false });
    const values = searchFormValuesFromSavedSearch(saved);
    const html = searchPage({ values, savedSearches: [saved] });

    assert.strictEqual(values.pets, "false");
    assert.strictEqual(values.furnished, "");
    assert.include(html, "<option value=\"false\" selected>No</option>");
    assert.include(savedSearchResultsHref(saved), "pets=false");
  });
});

describe("searchResults", () => {
  it("shows the save control only when the caller can save", () => {
    assert.notInclude(searchResults(emptyPage), 'hx-post="/search/saved"');
    assert.include(searchResults(emptyPage, { canSave: true }), 'hx-post="/search/saved"');
    assert.include(searchResults(emptyPage, { canSave: true }), 'hx-include="#search-form"');
  });
});

describe("savedSearchesPanel", () => {
  it("lists the searches and offers apply and delete controls", () => {
    const html = savedSearchesPanel([savedSearch()]);

    assert.include(html, 'id="saved-searches"');
    assert.include(html, 'href="/search?saved=7"');
    assert.include(html, 'hx-post="/search/saved/7/delete"');
    assert.include(html, "Delete");
    assert.include(html, "</button>");
  });

  it("says when there are no saved searches yet", () => {
    assert.include(savedSearchesPanel([]), "No saved searches yet.");
  });

  it("escapes a stored name", () => {
    const html = savedSearchesPanel([savedSearch({ name: '<img src=x onerror="alert(1)">' })]);

    assert.notInclude(html, "<img src=x");
    assert.include(html, "&lt;img src=x");
  });

  it("renders a notice and an error when given one", () => {
    assert.include(savedSearchesPanel([], { notice: "Saved." }), "Saved.");
    const failed = savedSearchesPanel([], { error: "Could not load." });
    assert.include(failed, "Could not load.");
    assert.notInclude(failed, "No saved searches yet.");
  });
});

describe("saved search helpers", () => {
  it("builds the results URL from the exact stored criteria, false flags included", () => {
    const href = savedSearchResultsHref(savedSearch());
    const params = new URLSearchParams(href.split("?")[1] ?? "");

    assert.strictEqual(params.get("query"), "balcony");
    assert.strictEqual(params.get("kind"), "room");
    assert.strictEqual(params.get("regionCode"), "attica");
    assert.strictEqual(params.get("minPriceMinor"), "40000");
    assert.strictEqual(params.get("maxPriceMinor"), "120050");
    assert.strictEqual(params.get("minSizeSqm"), "20");
    assert.strictEqual(params.get("maxSizeSqm"), "50");
    assert.strictEqual(params.get("furnished"), "true");
    assert.strictEqual(params.get("ensuite"), "false");
    assert.isNull(params.get("smoking"));
    assert.isNull(params.get("pets"));
    assert.strictEqual(params.get("availableFrom"), "2026-03-01T00:00:00.000Z");
  });

  it("uses the plain results route for a criteria-less saved search", () => {
    const saved = savedSearch({
      query: null,
      kind: null,
      regionCode: null,
      minPriceMinor: null,
      maxPriceMinor: null,
      minSizeSqm: null,
      maxSizeSqm: null,
      furnished: null,
      ensuite: null,
      smoking: null,
      pets: null,
      availableFrom: null,
    });
    assert.strictEqual(savedSearchResultsHref(saved), "/search/results");
  });

  it("clears the name box out of band after a save", () => {
    assert.include(clearedNameInput(), 'hx-swap-oob="true"');
    assert.include(clearedNameInput(), 'id="saved-search-name"');
    assert.include(saveSearchForm(), 'id="saved-search-name"');
  });
});
