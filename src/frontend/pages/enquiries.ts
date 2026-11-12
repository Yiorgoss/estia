import { encodeKeysetCursor } from "@/db/schema/cursor";
import type { KeysetCursor } from "@/db/schema/cursor";
import type {
  ReceivedEnquiry,
  ReceivedEnquiryPage,
  SentEnquiry,
  SentEnquiryPage,
} from "@/db/schema/Enquiry";
import { pageShell, secondaryButtonClass } from "@/frontend/layout";
import { escapeHtml, formatDateTime } from "@/utils";

/*
 * The two sides of the contact path on one page: the enquiries a person's
 * listings received, and the ones they sent. Both lists are already scoped by
 * the service to the signed-in account, so this page has no identity logic - it
 * only renders what it is given, escaping every value a person supplied.
 */

export interface EnquiriesPageState {
  readonly received: typeof ReceivedEnquiryPage.Type;
  readonly sent: typeof SentEnquiryPage.Type;
  readonly receivedCursor?: KeysetCursor | undefined;
  readonly sentCursor?: KeysetCursor | undefined;
  readonly sentBanner?: boolean | undefined;
}

const cardClass = "rounded-lg border border-gray-200 bg-white p-5 shadow-sm";

const listingLink = (listingId: number, title: string) =>
  `<a href="/listings/${listingId}" class="font-semibold text-gray-900 hover:text-blue-700">${escapeHtml(title)}</a>`;

const sentBanner = (sent: boolean) =>
  sent
    ? `<p class="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800" role="status">Your enquiry was sent. The lister can now see your message, the display name and contact details from your profile, or your account email when those are not published.</p>`
    : "";

/*
 * Keyset paging only moves forwards. Each list keeps the other list where the
 * reader already was, so following the received list's next page does not send
 * the sent list back to its first page.
 */
const enquiriesHref = (
  state: EnquiriesPageState,
  overrides: { readonly received?: KeysetCursor; readonly sent?: KeysetCursor },
): string => {
  const search = new URLSearchParams();
  const received = overrides.received ?? state.receivedCursor;
  const sent = overrides.sent ?? state.sentCursor;
  if (received !== undefined) search.set("receivedCursor", encodeKeysetCursor(received));
  if (sent !== undefined) search.set("sentCursor", encodeKeysetCursor(sent));
  const query = search.toString();
  return query === "" ? "/enquiries" : `/enquiries?${query}`;
};

const nextPageControl = (href: string | null) =>
  href == null
    ? ""
    : `<div class="flex justify-center">
        <a href="${escapeHtml(href)}" class="${secondaryButtonClass}">Next page</a>
      </div>`;

const emptyState = (title: string, body: string) =>
  `<div class="rounded-lg border border-dashed border-gray-300 p-5 text-sm text-gray-600">
    <p class="font-medium text-gray-900">${title}</p>
    <p class="mt-1">${body}</p>
  </div>`;

const receivedCard = (enquiry: ReceivedEnquiry) => {
  const when = formatDateTime(enquiry.createdAt) ?? "Just now";
  const contact = `Contact: ${escapeHtml(enquiry.senderContact)}`;

  return `<article class="${cardClass}">
    <header class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h3 class="text-sm text-gray-600">${listingLink(enquiry.listingId, enquiry.listingTitle)}</h3>
      <time class="shrink-0 text-xs text-gray-500" datetime="${enquiry.createdAt.toISOString()}">${escapeHtml(when)}</time>
    </header>
    <p class="mt-3 text-sm text-gray-900">From <span class="font-medium">${escapeHtml(enquiry.senderName)}</span></p>
    <p class="mt-0.5 text-sm text-gray-600">${contact}</p>
    <p class="mt-3 whitespace-pre-line break-words rounded-md bg-gray-50 p-3 text-sm text-gray-700">${escapeHtml(enquiry.message)}</p>
  </article>`;
};

const sentCard = (enquiry: SentEnquiry) => {
  const when = formatDateTime(enquiry.createdAt) ?? "Just now";
  return `<article class="${cardClass}">
    <header class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h3 class="text-sm text-gray-600">${listingLink(enquiry.listingId, enquiry.listingTitle)}</h3>
      <time class="shrink-0 text-xs text-gray-500" datetime="${enquiry.createdAt.toISOString()}">${escapeHtml(when)}</time>
    </header>
    <p class="mt-3 whitespace-pre-line break-words rounded-md bg-gray-50 p-3 text-sm text-gray-700">${escapeHtml(enquiry.message)}</p>
  </article>`;
};

export const enquiriesPage = (state: EnquiriesPageState) =>
  pageShell(
    "Enquiries",
    `
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold text-gray-900">Enquiries</h1>
        <p class="mt-1 text-sm text-gray-600">
          Messages between signed-in people and the listings they answered. There
          is no thread: reply on the contact details shown.
        </p>
      </div>
      <a href="/search" class="${secondaryButtonClass}">Back to listings</a>
    </div>

    <div class="mt-4 space-y-4">
      ${sentBanner(state.sentBanner === true)}
    </div>

    <section class="mt-6">
      <h2 class="text-base font-semibold text-gray-900">Enquiries your listings received</h2>
      <p class="mt-1 text-sm text-gray-600">
        Everyone who used the contact form on one of your listings, newest first.
      </p>
      <div class="mt-3 space-y-3">
        ${
          state.received.items.length === 0
            ? emptyState(
                "No enquiries yet",
                "When someone sends an enquiry from one of your published listings, it appears here.",
              )
            : state.received.items.map(receivedCard).join("")
        }
      </div>
      ${nextPageControl(
        state.received.nextCursor == null
          ? null
          : enquiriesHref(state, { received: state.received.nextCursor }),
      )}
    </section>

    <section class="mt-8">
      <h2 class="text-base font-semibold text-gray-900">Enquiries you sent</h2>
      <p class="mt-1 text-sm text-gray-600">
        What you sent to a lister, so the action is never a black hole.
      </p>
      <div class="mt-3 space-y-3">
        ${
          state.sent.items.length === 0
            ? emptyState(
                "You have not sent an enquiry yet",
                "Open a published listing and use the contact form to send one.",
              )
            : state.sent.items.map(sentCard).join("")
        }
      </div>
      ${nextPageControl(
        state.sent.nextCursor == null
          ? null
          : enquiriesHref(state, { sent: state.sent.nextCursor }),
      )}
    </section>`,
  );
