import type { PublicListing } from "@/api/public";
import { head } from "@/frontend/head";
import { header } from "@/frontend/header";
import { kindLabels, listingFlags, regionLabels } from "@/frontend/listing-labels";
import { escapeHtml, formatDate, formatPriceMinor } from "@/utils";

/*
 * The visitor-facing detail page. It is rendered from the public projection in
 * `@/api/public`, never from the listing row, so the page cannot accidentally
 * print an owner id or a coordinate: the fields it wants are the fields the
 * projection has.
 *
 * Unlike the owner pages, this one is read by people arriving from a search
 * result or a shared link, so the shell carries real `<title>`/description
 * metadata and the not-found page asks search engines not to index it.
 */

const backLinkClass =
  "inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:text-blue-800";
const primaryButtonClass =
  "inline-block rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800";
const secondaryButtonClass =
  "inline-block rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50";
const chipClass = "rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700";
const sectionHeadingClass = "text-sm font-semibold text-gray-900";

interface PageMetadata {
  readonly title: string;
  readonly description: string;
  // A listing that does not exist has nothing to offer a crawler or a preview.
  readonly noindex?: boolean;
}

const pageShell = (
  metadata: PageMetadata,
  content: string,
  // A page whose content already offers the way back does not repeat it in the
  // frame.
  options: { readonly backLink?: boolean } = {},
) => `<!DOCTYPE html>
<html lang="en">
<head>
  ${head}
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(metadata.title)}</title>
  <meta name="description" content="${escapeHtml(metadata.description)}">
  <meta property="og:title" content="${escapeHtml(metadata.title)}">
  <meta property="og:description" content="${escapeHtml(metadata.description)}">
  ${metadata.noindex === true ? '<meta name="robots" content="noindex">' : ""}
</head>
<body class="min-h-lvh bg-gray-50">
  ${header}
  <main class="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
    ${
      options.backLink === false
        ? ""
        : `<a href="/search" class="${backLinkClass}">&larr; Back to search</a>`
    }
    ${content}
  </main>
</body>
</html>
`;

// Sharing surfaces cut the description off after roughly one sentence, so the
// summary is flattened and bounded rather than pasted whole into an attribute.
const SUMMARY_LIMIT = 160;

const summarise = (text: string): string => {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length <= SUMMARY_LIMIT
    ? flattened
    : `${flattened.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…`;
};

const detailRow = (label: string, value: string) => `
  <div class="flex items-baseline justify-between gap-4 border-b border-gray-100 py-2 last:border-b-0">
    <dt class="text-sm text-gray-500">${label}</dt>
    <dd class="text-right text-sm font-medium text-gray-900">${value}</dd>
  </div>`;

// A flag that is false is not advertised, so only the true ones are chips.
const flagChips = (flags: ReadonlyArray<string>) =>
  flags.length === 0
    ? ""
    : `<ul class="mt-2 flex flex-wrap gap-2">
        ${flags.map((flag) => `<li class="${chipClass}">${flag}</li>`).join("")}
      </ul>`;

// A listing with no photos simply has no gallery section: the page still
// renders every fact it has, and the search card falls back to its placeholder.
const gallery = (listing: PublicListing): string => {
  if (listing.photos.length === 0) return "";
  const [first, ...rest] = listing.photos;
  if (first === undefined) return "";
  const alt = (index: number) => `${listing.title} - photo ${index + 1}`;

  return `
      <section class="border-b border-gray-100 p-5 sm:p-6" aria-label="Photos">
        <h2 class="${sectionHeadingClass}">Photos</h2>
        <div class="mt-3 space-y-2">
          <img
            src="${escapeHtml(first.url)}"
            alt="${escapeHtml(alt(0))}"
            class="aspect-[4/3] w-full rounded-md bg-gray-100 object-cover"
          />
          ${
            rest.length === 0
              ? ""
              : `<div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  ${rest
                    .map(
                      (photo, index) => `<img
                        src="${escapeHtml(photo.url)}"
                        alt="${escapeHtml(alt(index + 1))}"
                        loading="lazy"
                        class="aspect-[4/3] w-full rounded-md bg-gray-100 object-cover"
                      />`,
                    )
                    .join("")}
                </div>`
          }
        </div>
      </section>`;
};

/*
 * What the page may offer the visitor about contacting the owner. The listing
 * detail page is public, so the caller is resolved before it renders: a visitor
 * gets a sign-in link, the owner is told the messages land in their own chats,
 * and anyone else gets the one control that starts or reopens the thread.
 */
export type ListingContact =
  | { readonly _tag: "anonymous" }
  | { readonly _tag: "owner" }
  | { readonly _tag: "member" };

const contactSection = (listing: PublicListing, contact: ListingContact): string => {
  if (contact._tag === "owner") {
    return `
      <section class="mt-6 border-t border-gray-100 pt-4">
        <h2 class="${sectionHeadingClass}">Contact</h2>
        <p class="mt-2 text-sm text-gray-600">
          This is your listing. Messages about it appear in <a href="/chats" class="font-medium text-blue-700 hover:text-blue-800">your chats</a>.
        </p>
      </section>`;
  }

  if (contact._tag === "anonymous") {
    return `
      <section class="mt-6 border-t border-gray-100 pt-4">
        <h2 class="${sectionHeadingClass}">Contact the owner</h2>
        <p class="mt-2 text-sm text-gray-600">Sign in to message the owner about this listing.</p>
        <p class="mt-3">
          <a href="/login" class="${primaryButtonClass}">Sign in to message</a>
        </p>
      </section>`;
  }

  return `
    <section class="mt-6 border-t border-gray-100 pt-4">
      <h2 class="${sectionHeadingClass}">Contact the owner</h2>
      <p class="mt-2 text-sm text-gray-600">
        Your message starts a chat with the owner. Replies appear in
        <a href="/chats" class="font-medium text-blue-700 hover:text-blue-800">your chats</a>.
      </p>
      <form method="post" action="/chats/start" class="mt-3">
        <input type="hidden" name="listingId" value="${listing.id}" />
        <label for="contact-body" class="block text-sm font-medium text-gray-900">Your message</label>
        <textarea id="contact-body" name="body" rows="3" required maxlength="4000"
                  class="mt-2 block w-full rounded-md border border-gray-300 p-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"></textarea>
        <button type="submit" class="mt-3 ${primaryButtonClass}">Send message</button>
      </form>
    </section>`;
};

export const listingDetailPage = (
  listing: PublicListing,
  contact: ListingContact = { _tag: "anonymous" },
) => {
  const region = regionLabels[listing.regionCode];
  const kind = kindLabels[listing.kind];
  const available = formatDate(listing.availableFrom);
  const published = formatDate(listing.publishedAt);
  const flags = listingFlags(listing);
  const hasDescription = listing.description != null && listing.description.trim() !== "";

  const metadata: PageMetadata = {
    title: `${listing.title} - ${region}`,
    description: hasDescription
      ? summarise(listing.description ?? "")
      : `${kind} in ${region}, ${formatPriceMinor(listing.priceMinor)} per month.`,
  };

  // Built separately so the template's own indentation never reaches a block
  // that preserves newlines: a description's first line would sit below a blank
  // one otherwise.
  const description = hasDescription
    ? escapeHtml(listing.description ?? "")
    : "No description provided.";

  return pageShell(
    metadata,
    `
    <article class="mt-4 rounded-lg border border-gray-200 bg-white shadow-sm">
      <header class="border-b border-gray-100 p-5 sm:p-6">
        <p class="text-xs font-medium uppercase tracking-wide text-gray-500">
          ${escapeHtml(region)} &middot; ${escapeHtml(kind)}
        </p>
        <div class="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <h1 class="break-words text-2xl font-semibold text-gray-900">
            ${escapeHtml(listing.title)}
          </h1>
          <p class="shrink-0 text-2xl font-semibold text-blue-700">
            ${formatPriceMinor(listing.priceMinor)}<span class="text-sm font-normal text-gray-500">/mo</span>
          </p>
        </div>
      </header>

      ${gallery(listing)}

      <div class="p-5 sm:p-6">
        <section>
          <h2 class="${sectionHeadingClass}">Description</h2>
          <p class="mt-2 whitespace-pre-line break-words text-sm leading-relaxed text-gray-600">${description}</p>
        </section>

        ${
          flags.length === 0
            ? ""
            : `<section class="mt-6">
                 <h2 class="${sectionHeadingClass}">Details</h2>
                 ${flagChips(flags)}
               </section>`
        }

        <section class="mt-6">
          <h2 class="${sectionHeadingClass}">At a glance</h2>
          <dl class="mt-2">
            ${detailRow("Kind", escapeHtml(kind))}
            ${detailRow("Region", escapeHtml(region))}
            ${detailRow("Size", listing.sizeSqm == null ? "Not stated" : `${listing.sizeSqm} m²`)}
            ${detailRow("Available from", available ?? "Not stated")}
            ${detailRow("Published", published ?? "Not stated")}
          </dl>
        </section>

        ${contactSection(listing, contact)}
      </div>
    </article>
    `,
  );
};

/*
 * A missing listing and an unpublished one are the same page: the public route
 * cannot tell the two apart, and neither can a visitor. Everything a listing
 * supplied is escaped by the page, so a description containing markup is read,
 * not executed.
 */
export const listingNotFoundPage = () =>
  pageShell(
    {
      title: "Listing not found",
      description: "This listing is not available. Search published listings instead.",
      noindex: true,
    },
    `
    <div class="mt-4 rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
      <h1 class="text-2xl font-semibold text-gray-900">Listing not found</h1>
      <p class="mt-2 text-sm text-gray-600">
        This listing does not exist, or it is no longer published. Its owner may have unlisted it.
      </p>
      <p class="mt-5">
        <a href="/search" class="${secondaryButtonClass}">Back to search</a>
      </p>
    </div>
    `,
    { backLink: false },
  );

// The failure page still offers the way back, so a transient error is not a dead end.
export const listingUnavailablePage = () =>
  pageShell(
    {
      title: "Listing unavailable",
      description: "This listing could not be loaded just now.",
      noindex: true,
    },
    `
    <div class="mt-4 rounded-lg border border-red-200 bg-red-50 p-5 sm:p-6" role="alert">
      <h1 class="text-2xl font-semibold text-gray-900">Something went wrong</h1>
      <p class="mt-2 text-sm text-red-700">
        This listing could not be loaded just now. Please try again.
      </p>
      <p class="mt-5">
        <a href="/search" class="${secondaryButtonClass}">Back to search</a>
      </p>
    </div>
    `,
    { backLink: false },
  );
