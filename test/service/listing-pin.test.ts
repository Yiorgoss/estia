import {
  approximateLocation,
  LOCATION_GRID_HUNDREDTHS_PER_DEGREE,
  LOCATION_MAX_ERROR_KM,
} from "@/db/schema/ListingPin";
import { GREEK_LATITUDE_RANGE, GREEK_LONGITUDE_RANGE } from "@/db/schema/Listing";
import { assert, describe, it } from "@effect/vitest";

/*
 * The map's promise, proved: rounding a coordinate to a hundredth of a degree
 * is pure, stable, idempotent, and never moves a pin more than
 * `LOCATION_MAX_ERROR_KM` from the true point anywhere in Greece. That constant
 * is also the sentence the map page prints, so this file is what keeps the copy
 * honest.
 */

const EARTH_RADIUS_KM = 6371.0088;
const GRID = LOCATION_GRID_HUNDREDTHS_PER_DEGREE;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

// Great-circle distance between two points, in kilometres.
const distanceKm = (aLat: number, aLng: number, bLat: number, bLng: number): number => {
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(aLat)) * Math.cos(toRadians(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
};

describe("approximateLocation", () => {
  it("rounds both axes to the public grid", () => {
    assert.strictEqual(GRID, 100);
    assert.deepStrictEqual(approximateLocation(37.9838, 23.7275), { lat: 37.98, lng: 23.73 });
    assert.deepStrictEqual(approximateLocation(35.2431, 25.7219), { lat: 35.24, lng: 25.72 });
  });

  it("never produces float noise", () => {
    // Rounding through integer hundredths keeps the wire value a clean decimal.
    const rounded = approximateLocation(37.984, 23.727);
    assert.strictEqual(rounded.lat, 37.98);
    assert.strictEqual(String(rounded.lat), "37.98");
    assert.strictEqual(String(rounded.lng), "23.73");
    assert.notInclude(String(rounded.lat), "000000");
  });

  it("is pure: same input, same output, and the input is untouched", () => {
    const input = Object.freeze({ lat: 38.2466, lng: 21.7346 });
    const first = approximateLocation(input.lat, input.lng);
    const second = approximateLocation(input.lat, input.lng);

    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(input, { lat: 38.2466, lng: 21.7346 });
  });

  it("is idempotent: a rounded point rounds to itself", () => {
    const once = approximateLocation(40.6401, 22.9444);
    const twice = approximateLocation(once.lat, once.lng);
    assert.deepStrictEqual(twice, once);

    // Every grid point in the Greek box is a fixed point of the rule. A stride
    // keeps the sweep a sample rather than 900k assertions.
    for (
      let lat = Math.ceil(GREEK_LATITUDE_RANGE.minimum * GRID);
      lat <= GREEK_LATITUDE_RANGE.maximum * GRID;
      lat += 17
    ) {
      for (
        let lng = Math.ceil(GREEK_LONGITUDE_RANGE.minimum * GRID);
        lng <= GREEK_LONGITUDE_RANGE.maximum * GRID;
        lng += 17
      ) {
        const point = { lat: lat / GRID, lng: lng / GRID };
        const again = approximateLocation(point.lat, point.lng);
        assert.strictEqual(again.lat, point.lat);
        assert.strictEqual(again.lng, point.lng);
      }
    }
  });

  it("collapses two listings in one cell onto the same pin", () => {
    // These are different addresses in the same ~1 km cell; the rule cannot
    // tell them apart, and that is the privacy guarantee working.
    const a = approximateLocation(37.9801, 23.7301);
    const b = approximateLocation(37.9849, 23.7349);

    assert.notStrictEqual(37.9801, 37.9849);
    assert.notStrictEqual(23.7301, 23.7349);
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(a, { lat: 37.98, lng: 23.73 });
  });

  it("keeps every point in Greece within LOCATION_MAX_ERROR_KM of its pin", () => {
    /*
     * The largest displacement inside one cell is at the cell's midpoint on
     * both axes, so sweeping midpoints over the whole Greek box finds the true
     * worst case - not a sample. A cell is 1.11 km tall and 0.92 km wide at
     * 34N, so half a diagonal is the bound.
     */
    assert.strictEqual(LOCATION_MAX_ERROR_KM, 0.75);

    let worstKm = 0;
    let worstAt = { lat: 0, lng: 0 };

    const firstLat = Math.ceil(GREEK_LATITUDE_RANGE.minimum * GRID);
    const lastLat = Math.floor(GREEK_LATITUDE_RANGE.maximum * GRID) - 1;
    const firstLng = Math.ceil(GREEK_LONGITUDE_RANGE.minimum * GRID);
    const lastLng = Math.floor(GREEK_LONGITUDE_RANGE.maximum * GRID) - 1;

    for (let latHundredths = firstLat; latHundredths <= lastLat; latHundredths += 1) {
      for (let lngHundredths = firstLng; lngHundredths <= lastLng; lngHundredths += 1) {
        const lat = (latHundredths + 0.5) / GRID;
        const lng = (lngHundredths + 0.5) / GRID;
        const rounded = approximateLocation(lat, lng);
        const movedKm = distanceKm(lat, lng, rounded.lat, rounded.lng);
        if (movedKm > worstKm) {
          worstKm = movedKm;
          worstAt = { lat, lng };
        }
      }
    }

    // The sweep has to actually reach the worst case (~0.722 km), not a corner.
    assert.isAbove(worstKm, 0.7);
    assert.isAtMost(worstKm, LOCATION_MAX_ERROR_KM);
    assert.closeTo(worstKm, 0.722, 0.005);
    assert.closeTo(worstAt.lat, 34.005, 0.0001);
    assert.closeTo(worstAt.lng, 19.005, 0.0001);
  });
});
