import { StorageRepository } from "@/repos/storage.repo";
import { Config, Context, Effect, Layer, Option } from "effect";
import {
  Headers as HttpHeaders,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

/*
 * The basemap archive lives in R2, not in the repo and not in static assets:
 * Cloudflare caps one static asset at 25 MiB and the Greece cutout is already
 * ~39 MB. This route is a thin, range-capable proxy over the existing `STORAGE`
 * bucket, so PMTiles can fetch just the header and the tiles it needs instead of
 * downloading the whole archive.
 *
 * `PMTILES_GREECE` names the archive and defaults to this route's own path, so
 * the placeholder the tile script seeds is the archive the page reads. Pointing
 * it at an R2 custom domain later is a config change, not a code change.
 */
const DEFAULT_PMTILES_GREECE = "/maps/greece.pmtiles";

/*
 * The archive path, resolved once when the app layer is built. Reading it here
 * rather than per request means the Worker binding `PMTILES_GREECE` is what the
 * page sees, instead of a per-request provider lookup that would bypass it.
 */
export const MapBasemapUrl = Context.Service<string>("MapBasemapUrl");

export const MapBasemapUrlLive = Layer.effect(
  MapBasemapUrl,
  Config.String("PMTILES_GREECE").pipe(Config.withDefault(DEFAULT_PMTILES_GREECE)),
);

const PMTILES_CONTENT_TYPE = "application/vnd.pmtiles";

// Only `maps/<name>.pmtiles` is reachable: one flat path segment, no dots that
// could walk out of the prefix, no other extension.
const PMTILES_KEY = /^[A-Za-z0-9._-]+\.pmtiles$/;

const notFound = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text("Not found", { status: 404 });

const unavailable = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text("The basemap is unavailable.", { status: 500 });

// R2 reports the slice it served; turn it back into the headers a browser
// expects for a 206. A whole-object read keeps its 200 and full length.
//
// The check is on the value, not on `"suffix" in range`: the runtime can expose
// all three optional members with `undefined` values, and a bare `in` would then
// take the suffix branch and produce `NaN` offsets.
const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const normalizeRange = (range: R2Range, size: number): { offset: number; length: number } => {
  const candidate = range as { offset?: number; length?: number; suffix?: number };
  const suffix = finiteOr(candidate.suffix, -1);
  if (suffix >= 0) {
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Math.min(finiteOr(candidate.offset, 0), size);
  const length = Math.min(finiteOr(candidate.length, size - offset), size - offset);
  return { offset, length };
};

const pmtilesResponse = (
  object: R2ObjectBody,
  ranged: boolean,
): HttpServerResponse.HttpServerResponse => {
  const headers = new Headers({
    "content-type": PMTILES_CONTENT_TYPE,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=86400",
    etag: object.httpEtag,
  });

  // The status follows the request, not just the object: the local R2 emulator
  // reports a whole-object range even when no Range was sent, and a plain GET
  // must still be a 200.
  if (!ranged || object.range === undefined) {
    headers.set("content-length", String(object.size));
    return HttpServerResponse.fromWeb(new Response(object.body, { status: 200, headers }));
  }

  const { offset, length } = normalizeRange(object.range, object.size);
  headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
  headers.set("content-length", String(length));
  return HttpServerResponse.fromWeb(new Response(object.body, { status: 206, headers }));
};

/*
 * The route never echoes a key or a bucket name on failure: a malformed or
 * unknown key is the same 404, and a driver failure is a 500 with a fixed body.
 * That keeps the storage layout out of the public surface.
 */
export const MapTilesRoute = HttpRouter.route("GET", "/maps/:key", () =>
  Effect.gen(function* () {
    const key = yield* Effect.map(HttpRouter.params, (params) => params["key"]);
    if (key === undefined || !PMTILES_KEY.test(key)) return notFound();

    const request = yield* HttpServerRequest.HttpServerRequest;
    const range = Option.getOrUndefined(HttpHeaders.get(request.headers, "range"));

    const storage = yield* StorageRepository;
    const object = yield* storage.get(`maps/${key}`, range);
    if (Option.isNone(object)) return notFound();

    return pmtilesResponse(object.value, range !== undefined);
  }).pipe(
    Effect.catchTag("R2ReadError", (error) =>
      Effect.logError("Basemap read failed", { error }).pipe(Effect.andThen(Effect.succeed(unavailable()))),
    ),
  ),
);
