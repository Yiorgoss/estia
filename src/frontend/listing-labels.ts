import type { GreekRegionCode, ListingKind, ListingStatus } from "@/db/schema/Listing";

/*
 * Human-readable names for the controlled region set. The `satisfies` keeps the
 * map exhaustive: adding a region code without a label is a type error, so the
 * select can never silently drop one.
 */
export const regionLabels = {
  attica: "Attica",
  central_greece: "Central Greece",
  central_macedonia: "Central Macedonia",
  crete: "Crete",
  eastern_macedonia_and_thrace: "Eastern Macedonia and Thrace",
  epirus: "Epirus",
  ionian_islands: "Ionian Islands",
  north_aegean: "North Aegean",
  peloponnese: "Peloponnese",
  south_aegean: "South Aegean",
  thessaly: "Thessaly",
  western_greece: "Western Greece",
  western_macedonia: "Western Macedonia",
} as const satisfies Record<GreekRegionCode, string>;

export const kindLabels = {
  room: "Room",
  whole_property: "Whole property",
  room_wanted: "Room wanted",
} as const satisfies Record<ListingKind, string>;

/*
 * The flags a visitor reads. Search cards and the public detail page show the
 * same subset in the same order, so the true flags live in one place and a
 * `false` flag is simply absent.
 */
export const listingFlags = (listing: {
  readonly furnished: boolean;
  readonly ensuite: boolean;
  readonly smoking: boolean;
  readonly pets: boolean;
}): ReadonlyArray<string> =>
  [
    listing.furnished ? "Furnished" : undefined,
    listing.ensuite ? "Ensuite" : undefined,
    listing.smoking ? "Smoking allowed" : undefined,
    listing.pets ? "Pets allowed" : undefined,
  ].filter((flag) => flag !== undefined);

// "unpublished" is the database word; an owner reading the page sees "Unlisted".
export const statusLabels = {
  draft: "Draft",
  published: "Published",
  unpublished: "Unlisted",
} as const satisfies Record<ListingStatus, string>;
