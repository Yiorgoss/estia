import { encodeListingCursor, ListingPage } from "@/db/schema/Listing";
import { kindLabels, listingFlags, regionLabels } from "@/frontend/listing-labels";
import { escapeHtml, formatDate, formatPriceMinor } from "@/utils";

type SearchListing = (typeof ListingPage.Type)["items"][number];

/*
 * The whole card is the link to the listing's public page: a visitor reads a
 * result and opens it, and nothing inside a card is a separate action.
 */
const listingCard = (listing: SearchListing) => {
  const flags = listingFlags(listing);
  const available = formatDate(listing.availableFrom);

  return `
    <a
      href="/listings/${listing.id}"
      class="group flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-5 shadow-sm transition-colors hover:border-blue-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
    >
      <header class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="break-words text-base font-semibold text-gray-900 group-hover:text-blue-700">${escapeHtml(listing.title)}</h2>
          <p class="mt-0.5 text-xs font-medium uppercase tracking-wide text-gray-500">
            ${escapeHtml(regionLabels[listing.regionCode])} &middot; ${escapeHtml(kindLabels[listing.kind])}
          </p>
        </div>
        <p class="shrink-0 text-lg font-semibold text-blue-700">
          ${formatPriceMinor(listing.priceMinor)}<span class="text-xs font-normal text-gray-500">/mo</span>
        </p>
      </header>
      ${
        listing.description == null
          ? ""
          : `<p class="text-sm text-gray-600">${escapeHtml(listing.description)}</p>`
      }
      ${
        flags.length === 0
          ? ""
          : `<ul class="flex flex-wrap gap-2">
              ${flags
                .map(
                  (flag) =>
                    `<li class="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">${flag}</li>`,
                )
                .join("")}
            </ul>`
      }
      <footer class="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-3 text-xs text-gray-500">
        <span>${listing.sizeSqm == null ? "Size unknown" : `${listing.sizeSqm} m²`}</span>
        <span>${available == null ? "Availability unknown" : `Available ${available}`}</span>
      </footer>
    </a>`;
};

/*
 * Keyset paging only moves forwards, so there is a `Next page` control and no
 * previous-page one. The button re-sends the current form values plus the
 * cursor the server handed out; the page only re-encodes that cursor, never
 * invents an offset.
 */
const nextPageControl = (page: typeof ListingPage.Type) =>
  page.nextCursor == null
    ? ""
    : `<div class="flex justify-center">
        <button
          type="button"
          hx-get="/search/results"
          hx-include="#search-form"
          hx-vals='{"cursor":"${encodeListingCursor(page.nextCursor)}"}'
          hx-target="#results"
          hx-swap="innerHTML"
          class="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 [.htmx-request_&]:cursor-progress [.htmx-request_&]:opacity-60"
        >
          Next page
        </button>
      </div>`;

// There is no total count with a keyset cursor, so the label only ever claims
// what this page actually shows.
const countLabel = (count: number) =>
  `<p class="text-sm text-gray-600">
     Showing ${count} ${count === 1 ? "listing" : "listings"}, newest first
   </p>`;

export const searchResults = (page: typeof ListingPage.Type) => `
  <div class="space-y-4" aria-live="polite">
    ${
      page.items.length === 0
        ? `<p class="rounded-lg border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
             No listings match these filters.
           </p>`
        : `${countLabel(page.items.length)}
           <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">${page.items.map(listingCard).join("")}</div>
           ${nextPageControl(page)}`
    }
  </div>`;

export const searchResultsError = (message: string) => `
  <p class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" aria-live="polite">
    ${escapeHtml(message)}
  </p>`;
