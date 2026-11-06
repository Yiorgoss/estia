import type { GreekRegionCode, ListingKind } from "@/db/schema/Listing";

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
