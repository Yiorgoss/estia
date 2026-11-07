import type { ListingStatus } from "@/db/schema/Listing";
import { statusLabels } from "@/frontend/listing-labels";

/*
 * How a listing's status reads on screen: the badge colour, and the sentence
 * that tells its owner what the status means. The edit page and the mine page
 * both render these, so a status is worded and coloured the same way wherever
 * an owner sees it.
 */

export const statusBadgeClass = {
  draft: "bg-gray-100 text-gray-700",
  published: "bg-green-100 text-green-800",
  unpublished: "bg-amber-100 text-amber-800",
} as const satisfies Record<ListingStatus, string>;

export const statusNotes = {
  draft:
    "Only you can see a draft. Publish it to show it in public search and give it a public page.",
  published: "This listing is published: it appears in public search and has its own public page.",
  unpublished:
    "This listing is unlisted: it is hidden from public search and its public page, with all its details kept.",
} as const satisfies Record<ListingStatus, string>;

export const statusBadge = (status: ListingStatus) =>
  `<span class="rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass[status]}">${statusLabels[status]}</span>`;
