import type { PublicListingPin } from "@/db/schema/ListingPin";
import { LOCATION_MAX_ERROR_KM } from "@/db/schema/ListingPin";
import { GREEK_LATITUDE_RANGE, GREEK_LONGITUDE_RANGE } from "@/db/schema/Listing";
import { head } from "@/frontend/head";
import { header } from "@/frontend/header";
import { pageShell } from "@/frontend/layout";

/*
 * The listings map. The shell is server-rendered - pins travel in a JSON block
 * and the map itself is browser-side - so a visitor sees the pins even if the
 * basemap archive is missing.
 *
 * The stacked CDN stack is pinned by hand, exactly like `head.ts` pins Tailwind,
 * Alpine, and htmx: MapLibre GL JS, the PMTiles protocol, and the Protomaps
 * basemap style. All three run in the browser; nothing here is bundled into the
 * Worker. ODbL attribution for the Protomaps data is the visible line under the
 * map, not a folded-away corner control.
 *
 * `LOCATION_MAX_ERROR_KM` is the same constant the rounding rule and its unit
 * test use, so the promise in this copy cannot drift from the guarantee.
 */

export interface MapPageInput {
  readonly basemapUrl: string;
  readonly pins: ReadonlyArray<PublicListingPin>;
  readonly truncated: boolean;
}

const MAPLIBRE_JS = "https://unpkg.com/maplibre-gl@6.17.0/dist/maplibre-gl.mjs";
const MAPLIBRE_CSS = "https://unpkg.com/maplibre-gl@6.17.0/dist/maplibre-gl.css";
const PMTILES_JS = "https://unpkg.com/pmtiles@4.5.0/dist/pmtiles.js";
const BASEMAPS_JS = "https://unpkg.com/@protomaps/basemaps@5.7.2/dist/basemaps.js";

const ATTRIBUTION = "Basemap © OpenStreetMap contributors (ODbL), tiles by Protomaps";

// Pins that share a grid cell collapse onto one coordinate by design, so a
// group fans out on this small circle. Presentation only: the wire coordinate
// never moves.
const FANOUT_PX = 18;

const mapStyles = `
  #listing-map { height: 70vh; min-height: 420px; }
  .estia-pin { display: block; padding: 0; border: 0; background: none; cursor: pointer; line-height: 0; }
  .estia-pin svg { display: block; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35)); }
  .estia-pin:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 2px; border-radius: 4px; }
  .estia-popup { max-width: 220px; }
  .estia-popup h2 { margin: 0; font-size: 14px; font-weight: 600; color: #111827; }
  .estia-popup p { margin: 4px 0 8px; font-size: 13px; color: #4b5563; }
  .estia-popup a { font-size: 13px; font-weight: 600; color: #1d4ed8; text-decoration: none; }
  .estia-popup a:hover { text-decoration: underline; }
`;

/*
 * The browser half. It reads the pins the server already projected, probes the
 * archive's PMTiles header (the first range request the map would make anyway)
 * and, when that fails, shows the banner while still placing the pins on a
 * plain background: a map without context is still useful, a blank page is not.
 */
const mapScript = `
const container = document.getElementById("listing-map");
const banner = document.getElementById("map-banner");
const payload = JSON.parse(document.getElementById("map-data").textContent);

const showBanner = (message) => {
  banner.textContent = message;
  banner.hidden = false;
};

const pinElement = (pin) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "estia-pin";
  button.setAttribute("aria-label", "Listing: " + pin.title);
  button.innerHTML =
    '<svg viewBox="0 0 24 32" width="24" height="32" aria-hidden="true" focusable="false">' +
    '<path d="M12 1C6 1 1 6 1 12c0 8 11 19 11 19s11-11 11-19c0-6-5-11-11-11z" fill="#1d4ed8" stroke="#ffffff" stroke-width="1.5"/>' +
    '<path d="M6.5 13.5 12 8.5l5.5 5v5h-3.6v-4h-3.8v4H6.5z" fill="#ffffff"/>' +
    "</svg>";
  return button;
};

const priceLabel = (pin) => {
  const fractionDigits = pin.priceMinor % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: pin.currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(pin.priceMinor / 100);
};

const popupContent = (pin) => {
  const wrapper = document.createElement("div");
  wrapper.className = "estia-popup";
  const title = document.createElement("h2");
  title.textContent = pin.title;
  const facts = document.createElement("p");
  const price = priceLabel(pin);
  facts.textContent = pin.sizeSqm == null ? price : price + " · " + pin.sizeSqm + " m²";
  const link = document.createElement("a");
  link.href = "/listings/" + pin.id;
  link.textContent = "Open listing";
  wrapper.append(title, facts, link);
  return wrapper;
};

const plainStyle = () => ({
  version: 8,
  sources: {},
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#e8edf1" } },
  ],
});

const protomapsStyle = (url) => ({
  version: 8,
  glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
  sprite: "https://protomaps.github.io/basemaps-assets/sprites/v4/light",
  sources: {
    protomaps: {
      type: "vector",
      url: "pmtiles://" + url,
      attribution: ${JSON.stringify(ATTRIBUTION)},
    },
  },
  layers: (() => {
    const flavor = basemaps.namedFlavor("light");
    const layers = basemaps.layers("protomaps", flavor, { lang: "en" });
    // The archive is a Greece cutout, so the viewport margin can reach past the
    // tiles it contains. Painting the base layer with the sea colour makes that
    // margin read as open water instead of a grey band.
    return layers.map((layer) =>
      layer.id === "background"
        ? Object.assign({}, layer, { paint: { "background-color": flavor.water } })
        : layer,
    );
  })(),
});

const probeBasemap = async (url) => {
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-126" } });
    if (!response.ok) return false;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const magic = String.fromCharCode.apply(null, bytes.slice(0, 7));
    return magic === "PMTiles";
  } catch (error) {
    return false;
  }
};

const addPins = (maplibregl, map) => {
  const groups = new Map();
  for (const pin of payload.pins) {
    const key = pin.lat + "," + pin.lng;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [pin]);
    else group.push(pin);
  }

  // A pin is ~24px wide, so a group's circle has to be big enough that the
  // chord between neighbours clears one pin. Small groups keep the tight 18px
  // ring; a busy cell opens up instead of stacking into an unclickable blob.
  const fanOutRadius = (count) =>
    count <= 1 ? 0 : Math.max(${FANOUT_PX}, 13 / Math.sin(Math.PI / count));

  for (const group of groups.values()) {
    const radius = fanOutRadius(group.length);
    group.forEach((pin, index) => {
      const angle = (2 * Math.PI * index) / group.length;
      const offset = radius === 0 ? [0, 0] : [Math.cos(angle) * radius, Math.sin(angle) * radius];
      const popup = new maplibregl.Popup({ offset: 22, closeButton: true }).setDOMContent(
        popupContent(pin),
      );
      const marker = new maplibregl.Marker({ element: pinElement(pin), anchor: "bottom" })
        .setLngLat([pin.lng, pin.lat])
        .setPopup(popup)
        .addTo(map);
      marker.setOffset(offset);
    });
  }
};

const boot = async () => {
  const maplibregl = await import(${JSON.stringify(MAPLIBRE_JS)});

  const basemapOk = await probeBasemap(payload.basemapUrl);
  if (!basemapOk) {
    showBanner(
      "The basemap could not be loaded (" +
        payload.basemapUrl +
        "). The listings are still shown on a plain background.",
    );
  }

  if (basemapOk) {
    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);
    protocol.add(new pmtiles.PMTiles(payload.basemapUrl));
  }

  const map = new maplibregl.Map({
    container: container,
    style: basemapOk ? protomapsStyle(payload.basemapUrl) : plainStyle(),
    center: [22.5, 39.0],
    zoom: 5,
    attributionControl: false,
  });
  // Fit the whole country instead of a fixed zoom: the same view is readable at
  // desktop and phone widths, and Crete is never clipped off the bottom.
  map.fitBounds(payload.bounds, { padding: 24, duration: 0 });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("load", () => addPins(maplibregl, map));
};

boot().catch(() => {
  showBanner("The map could not be loaded. Use Browse as a list to see the listings.");
});
`;

// User content never reaches this file as markup: the pins travel as JSON and
// the script builds the popup with `textContent`, so a listing title cannot
// inject HTML. Only `<` needs escaping to keep `</script>` out of the block.
const toJsonBlock = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

export const mapPage = (input: MapPageInput): string => {
  const count = input.pins.length;
  const summary = input.truncated
    ? `Showing the newest ${count} published listings - older ones are not on the map.`
    : `Showing ${count} published ${count === 1 ? "listing" : "listings"}.`;

  const payload = toJsonBlock({
    basemapUrl: input.basemapUrl,
    pins: input.pins,
    truncated: input.truncated,
    // The country view the map opens on, so it fits any viewport.
    bounds: [
      [GREEK_LONGITUDE_RANGE.minimum, GREEK_LATITUDE_RANGE.minimum],
      [GREEK_LONGITUDE_RANGE.maximum, GREEK_LATITUDE_RANGE.maximum],
    ],
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${head}
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Listings map</title>
  <meta name="description" content="Where published listings are across Greece. Every pin is approximate to about ${LOCATION_MAX_ERROR_KM} km.">
  <link rel="stylesheet" href="${MAPLIBRE_CSS}">
  <script src="${PMTILES_JS}"></script>
  <script src="${BASEMAPS_JS}"></script>
  <style>${mapStyles}</style>
</head>
<body class="min-h-lvh bg-gray-50">
  ${header}
  <main class="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
    <div class="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div>
        <h1 class="text-2xl font-semibold text-gray-900">Listings map</h1>
        <p class="mt-1 max-w-2xl text-sm text-gray-600">
          Every pin is within about ${LOCATION_MAX_ERROR_KM} km of the listing's real spot - enough to compare
          neighbourhoods, never the exact address. Pins in the same spot are spread slightly so none is hidden.
        </p>
      </div>
      <a href="/search" class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
        Browse as a list
      </a>
    </div>

    <p id="map-summary" class="mt-4 text-sm font-medium text-gray-700">${summary}</p>

    <p
      id="map-banner"
      class="mt-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
      role="alert"
      hidden
    ></p>

    <div class="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      <div id="listing-map" class="w-full" role="region" aria-label="Map of published listings in Greece"></div>
    </div>

    <p class="mt-3 text-xs text-gray-500">
      ${ATTRIBUTION}.
    </p>
  </main>
  <script type="application/json" id="map-data">${payload}</script>
  <script type="module">${mapScript}</script>
</body>
</html>
`;
};

/*
 * The service reads happen before this page is rendered, so a database failure
 * must not look like "no listings": it gets its own honest page.
 */
export const mapUnavailablePage = (): string =>
  pageShell(
    "Listings map",
    `<h1 class="text-2xl font-semibold text-gray-900">The map is unavailable</h1>
     <p class="mt-2 text-sm text-gray-600">Published listings could not be read right now. Please try again.</p>
     <p class="mt-4">
       <a href="/search" class="font-medium text-blue-700 hover:text-blue-800">Browse the listings instead</a>
     </p>`,
  );
