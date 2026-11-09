import { mapPage, mapUnavailablePage } from "@/frontend/pages/map";
import { LOCATION_MAX_ERROR_KM } from "@/db/schema/ListingPin";
import type { PublicListingPin } from "@/db/schema/ListingPin";
import { assert, describe, it } from "@effect/vitest";

const pin = (overrides: Partial<PublicListingPin> = {}): PublicListingPin => ({
  id: 7 as PublicListingPin["id"],
  kind: "room",
  title: "Sunny studio in Athens",
  priceMinor: 120_000,
  currency: "EUR",
  regionCode: "attica",
  sizeSqm: 42,
  lat: 37.98,
  lng: 23.73,
  ...overrides,
});

const render = (
  pins: ReadonlyArray<PublicListingPin>,
  truncated = false,
  basemapUrl = "/maps/greece.pmtiles",
) => mapPage({ basemapUrl, pins, truncated });

describe("mapPage", () => {
  it("renders the pins the server projected and links the header to the map", () => {
    const html = render([pin(), pin({ id: 8 as PublicListingPin["id"], title: "Cretan house" })]);

    assert.include(html, "Sunny studio in Athens");
    assert.include(html, "Cretan house");
    assert.include(html, "Showing 2 published listings.");
    assert.include(html, 'href="/map"');
    assert.include(html, 'id="listing-map"');
    assert.include(html, 'id="map-data"');
  });

  it("states the same error radius the rounding rule guarantees", () => {
    const html = render([pin()]);

    assert.include(html, `within about ${LOCATION_MAX_ERROR_KM} km`);
    assert.include(html, "within about 0.75 km");
  });

  it("loads the pinned map stack and the configured basemap", () => {
    const html = render([pin()], false, "/maps/custom-greece.pmtiles");

    assert.include(html, "maplibre-gl@6.17.0");
    assert.include(html, "pmtiles@4.5.0");
    assert.include(html, "@protomaps/basemaps@5.7.2");
    assert.include(html, "/maps/custom-greece.pmtiles");
    // PMTiles is a range protocol: the page fetches slices of the archive.
    assert.include(html, "pmtiles://");
  });

  it("keeps the ODbL attribution visible on the page", () => {
    const html = render([pin()]);

    assert.include(html, "OpenStreetMap contributors");
    assert.include(html, "ODbL");
    assert.include(html, "Protomaps");
  });

  it("says when the map is capped instead of pretending it is complete", () => {
    const html = render([pin()], true);

    assert.include(html, "Showing the newest 1 published listings");
    assert.include(html, "older ones are not on the map");
  });

  it("carries pins as data, never as markup", () => {
    const title = 'Apt </script><script>alert("x")</script>';
    const html = render([pin({ title })]);

    assert.notInclude(html, title);
    assert.notInclude(html, "</script><script>alert");
    assert.include(html, "\\u003c/script");
  });

  it("carries the archive as page data and a hidden alert for the script to reveal", () => {
    const html = render([pin()], false, "/maps/missing.pmtiles");

    const marker = html.indexOf('id="map-data">');
    const end = html.indexOf("</script>", marker);
    const payload = JSON.parse(html.slice(html.indexOf(">", marker) + 1, end));
    assert.strictEqual(payload.basemapUrl, "/maps/missing.pmtiles");

    const bannerTag = /<[a-z]+\s[^>]*\bid="map-banner"[^>]*>/i.exec(html)?.[0] ?? "";
    assert.include(bannerTag, 'role="alert"');
    assert.match(bannerTag, /\bhidden\b/);
  });
});

describe("mapUnavailablePage", () => {
  it("explains the failure and offers the list instead", () => {
    const html = mapUnavailablePage();

    assert.include(html, "The map is unavailable");
    assert.include(html, 'href="/search"');
    assert.notInclude(html, "map-data");
  });
});
