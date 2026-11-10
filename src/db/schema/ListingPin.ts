import { ListingId } from "@/db/schema/brands";
import { Currency, GreekRegion, ListingKind, ListingSchema } from "@/db/schema/Listing";
import { Schema } from "effect";

/*
 * The map's privacy rule, in one place.
 *
 * A listing's stored coordinate is exact; the map must never publish it. The
 * rule is to round both axes to a hundredth of a degree, which snaps every
 * listing onto the same ~1 km grid cell it belongs to. Rounding is lossy in the
 * direction that matters: the value on the wire *is* the rounded value, so a
 * reader can only learn the cell, and a listing in the same cell shares a pin
 * with its neighbours by design.
 *
 * `LOCATION_MAX_ERROR_KM` is the promise the page makes ("within about 0.75
 * km") and the bound the unit test proves by sweeping the whole Greek box. The
 * worst case is half a cell diagonal: a cell is 1.11 km tall and 0.92 km wide at
 * 34N, so 0.722 km is the true maximum. Keep the promise and the test on this
 * same constant - a second number would let them drift.
 */
export const LOCATION_GRID_HUNDREDTHS_PER_DEGREE = 100;
export const LOCATION_MAX_ERROR_KM = 0.75;

const GRID = LOCATION_GRID_HUNDREDTHS_PER_DEGREE;

// Integer hundredths first, so the result is a clean decimal (37.98, never
// 37.980000000000004) and rounding the rounded value is a fixed point.
const toGrid = (degrees: number): number => Math.round(degrees * GRID) / GRID;

export interface ApproximateLocation {
  readonly lat: number;
  readonly lng: number;
}

export const approximateLocation = (lat: number, lng: number): ApproximateLocation => ({
  lat: toGrid(lat),
  lng: toGrid(lng),
});

/*
 * A map pin on the wire. `lat`/`lng` are the rounded values, never the stored
 * pair.
 */
export const PublicListingPin = Schema.Struct({
  id: ListingId,
  kind: ListingKind,
  title: Schema.String,
  priceMinor: Schema.Number,
  currency: Currency,
  regionCode: GreekRegion,
  sizeSqm: Schema.NullishOr(Schema.Number),
  lat: Schema.Number,
  lng: Schema.Number,
});
export type PublicListingPin = typeof PublicListingPin.Type;

export const ListingPinPage = Schema.Struct({
  pins: Schema.Array(PublicListingPin),
  truncated: Schema.Boolean,
});
export type ListingPinPage = typeof ListingPinPage.Type;

/*
 * What the repository returns: whole rows plus whether another row existed
 * beyond the requested limit. The projection to `PublicListingPin` happens at
 * the one public boundary, never here.
 */
export const ListingPinRows = Schema.Struct({
  items: Schema.Array(ListingSchema),
  truncated: Schema.Boolean,
});
export type ListingPinRows = typeof ListingPinRows.Type;
