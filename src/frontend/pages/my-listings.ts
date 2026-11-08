import { encodeListingCursor, type ListingPage } from "@/db/schema/Listing";
import {
  errorBanner,
  pageShell,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/frontend/layout";
import { kindLabels, regionLabels } from "@/frontend/listing-labels";
import { statusBadge, statusNotes } from "@/frontend/listing-status";
import { canTransition } from "@/services/listing.service";
import { escapeHtml, formatDate, formatPriceMinor } from "@/utils";

/*
 * The owner's own feed: every listing they have posted, drafts and unlisted
 * rows included, newest first. It is server-rendered like the create and edit
 * pages, so paging is a plain link carrying the model's opaque cursor, and
 * publish/unlist are forms posting to the same routes the edit page uses.
 *
 * A transition is only offered when the service's table says it is legal from
 * the status the row is in now, and every action names this page to come back
 * to, so a publish does not bounce the owner to an edit form.
 */

type MyListing = (typeof ListingPage.Type)["items"][number];

const rowAction = (
  listing: MyListing,
  action: "publish" | "unlist",
  label: string,
  selfHref: string,
  className: string,
) => `
  <form method="post" action="/listings/${listing.id}/${action}">
    <input type="hidden" name="returnTo" value="${escapeHtml(selfHref)}" />
    <button type="submit" class="${className}">${label}</button>
  </form>`;

const listingRow = (listing: MyListing, selfHref: string) => `
  <article class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="break-words text-base font-semibold text-gray-900">${escapeHtml(listing.title)}</h2>
          ${statusBadge(listing.status)}
        </div>
        <p class="mt-1 text-xs font-medium uppercase tracking-wide text-gray-500">
          ${escapeHtml(regionLabels[listing.regionCode])} &middot; ${escapeHtml(kindLabels[listing.kind])}
        </p>
      </div>
      <p class="shrink-0 text-lg font-semibold text-blue-700">
        ${formatPriceMinor(listing.priceMinor)}<span class="text-xs font-normal text-gray-500">/mo</span>
      </p>
    </div>

    <p class="mt-3 text-sm text-gray-600">${statusNotes[listing.status]}</p>

    <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
      <a href="/listings/${listing.id}/edit" class="${secondaryButtonClass}">Edit</a>
      ${
        canTransition(listing.status, "published")
          ? rowAction(listing, "publish", "Publish", selfHref, primaryButtonClass)
          : ""
      }
      ${
        canTransition(listing.status, "unpublished")
          ? rowAction(listing, "unlist", "Unlist", selfHref, secondaryButtonClass)
          : ""
      }
      <span class="ml-auto text-xs text-gray-500">
        Posted ${formatDate(listing.createdAt)}
      </span>
    </div>
  </article>`;

// Keyset paging only moves forwards, so there is a `Next page` link and no
// previous-page one. The cursor is the one the server handed out, re-encoded
// for the URL; the page never invents an offset.
const nextPageControl = (page: typeof ListingPage.Type) =>
  page.nextCursor == null
    ? ""
    : `<div class="flex justify-center">
        <a href="/listings/mine?cursor=${encodeListingCursor(page.nextCursor)}" class="${secondaryButtonClass}">
          Next page
        </a>
      </div>`;

// No total count exists with a keyset cursor, so the label only claims what this
// page actually shows.
const countLabel = (count: number) =>
  `<p class="text-sm text-gray-600">
     Showing ${count} ${count === 1 ? "listing" : "listings"}, newest first
   </p>`;

const emptyState = `
  <div class="rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center">
    <h2 class="text-base font-semibold text-gray-900">You have not posted a listing yet</h2>
    <p class="mt-1 text-sm text-gray-600">
      A listing starts as a draft that only you can see, and you can publish or unlist it from here.
    </p>
    <a href="/listings/new" class="mt-4 inline-block ${primaryButtonClass}">Post a listing</a>
  </div>`;

export const myListingsPage = (
  page: typeof ListingPage.Type,
  options: { readonly selfHref: string; readonly error?: string },
) =>
  pageShell(
    "My listings",
    `
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold text-gray-900">My listings</h1>
        <p class="mt-1 text-sm text-gray-600">
          Everything you have posted, drafts and unlisted listings included.
        </p>
      </div>
      <a href="/listings/new" class="${primaryButtonClass}">Post a listing</a>
    </div>

    <div class="mt-4 space-y-4">
      ${errorBanner(options.error)}
    </div>

    <section class="mt-6 space-y-4">
      ${
        page.items.length === 0
          ? emptyState
          : `${countLabel(page.items.length)}
             <div class="space-y-4">${page.items.map((listing) => listingRow(listing, options.selfHref)).join("")}</div>
             ${nextPageControl(page)}`
      }
    </section>`,
  );
