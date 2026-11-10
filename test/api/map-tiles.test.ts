import { MapTilesRoute } from "@/api/map-tiles";
import { R2ReadError, StorageRepository } from "@/repos/storage.repo";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { Etag, HttpPlatform, HttpRouter } from "effect/http";

/*
 * `GET /maps/:key` through the real router, over a fake R2 object. The point of
 * these tests is the byte-range contract PMTiles depends on: correct 200/206,
 * `content-range` arithmetic for prefix, bounded and suffix ranges, the key
 * mapping, and a 404/500 that never leaks the bucket or the key.
 */

const ARCHIVE = new TextEncoder().encode("PMTiles\x03\x10\x00\x00\x00ABCDEF");

// The local R2 emulator reports all three range members, with unused ones
// present but `undefined` - a shape that used to turn the arithmetic into NaN.
const rangeOf = (rangeHeader: string | undefined): R2Range => {
  if (rangeHeader === undefined)
    return { offset: 0, length: ARCHIVE.length, suffix: undefined } as unknown as R2Range;

  const spec = rangeHeader.replace(/^bytes=/, "");
  if (spec.startsWith("-")) {
    const length = Number(spec.slice(1));
    return { offset: ARCHIVE.length - length, length, suffix: undefined } as unknown as R2Range;
  }
  const [startText, endText] = spec.split("-");
  const offset = Number(startText);
  const length =
    (endText === undefined || endText === "" ? ARCHIVE.length - 1 : Number(endText)) - offset + 1;
  return { offset, length, suffix: undefined } as unknown as R2Range;
};

const objectFor = (range: R2Range): R2ObjectBody => {
  const candidate = range as { offset: number; length: number };
  const slice = ARCHIVE.slice(candidate.offset, candidate.offset + candidate.length);
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(slice);
        controller.close();
      },
    }),
    size: ARCHIVE.length,
    range,
    httpEtag: '"archive-etag"',
  } as unknown as R2ObjectBody;
};

interface Call {
  readonly key: string;
  readonly range: string | undefined;
}

const run = <A>(
  get: (
    key: string,
    range: string | undefined,
  ) => Effect.Effect<Option.Option<R2ObjectBody>, R2ReadError>,
  request: Request,
  check: (response: Response, calls: ReadonlyArray<Call>) => Effect.Effect<A>,
) => {
  const calls: Array<Call> = [];
  const storage = Layer.succeed(StorageRepository, {
    put: () => Effect.die("not used"),
    get: (key, range) =>
      Effect.suspend(() => {
        calls.push({ key, range });
        return get(key, range);
      }),
    newMultipart: () => Effect.die("not used"),
  });

  return Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpRouter.addAll([MapTilesRoute]).pipe(
          HttpRouter.provideRequest(storage),
          Layer.provide(Etag.layer),
          Layer.provide(HttpPlatform.layer),
          Layer.provide(Path.layer),
          Layer.provide(FileSystem.layerNoop({})),
        ),
        { disableLogger: true },
      ),
    ),
    ({ handler }) =>
      Effect.promise(() => handler(request)).pipe(
        Effect.flatMap((response) => check(response, calls)),
      ),
    ({ dispose }) => Effect.promise(dispose),
  );
};

const serveArchive = (key: string, range: string | undefined) =>
  key === "maps/greece.pmtiles"
    ? Effect.succeed(Option.some(objectFor(rangeOf(range))))
    : Effect.succeed(Option.none());

describe("GET /maps/:key", () => {
  it.effect("serves the whole archive as a 200", () =>
    run(serveArchive, new Request("http://localhost/maps/greece.pmtiles"), (response, calls) =>
      Effect.promise(async () => {
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get("content-type"), "application/vnd.pmtiles");
        assert.strictEqual(response.headers.get("accept-ranges"), "bytes");
        assert.strictEqual(response.headers.get("content-range"), null);
        assert.deepStrictEqual(calls, [{ key: "maps/greece.pmtiles", range: undefined }]);
        assert.strictEqual((await response.arrayBuffer()).byteLength, ARCHIVE.length);
      }),
    ),
  );

  it.effect("answers a bounded range with 206 and the right content-range", () =>
    run(
      serveArchive,
      new Request("http://localhost/maps/greece.pmtiles", { headers: { range: "bytes=0-6" } }),
      (response, calls) =>
        Effect.promise(async () => {
          assert.strictEqual(response.status, 206);
          assert.strictEqual(response.headers.get("content-range"), `bytes 0-6/${ARCHIVE.length}`);
          assert.strictEqual(response.headers.get("content-length"), "7");
          assert.deepStrictEqual(calls, [{ key: "maps/greece.pmtiles", range: "bytes=0-6" }]);
          const body = new Uint8Array(await response.arrayBuffer());
          assert.deepStrictEqual(Array.from(body), Array.from(ARCHIVE.slice(0, 7)));
        }),
    ),
  );

  it.effect("answers an open-ended range and a suffix range", () =>
    run(
      serveArchive,
      new Request("http://localhost/maps/greece.pmtiles", { headers: { range: "bytes=10-" } }),
      (response) =>
        Effect.promise(async () => {
          assert.strictEqual(response.status, 206);
          assert.strictEqual(
            response.headers.get("content-range"),
            `bytes 10-${ARCHIVE.length - 1}/${ARCHIVE.length}`,
          );
        }),
    ).pipe(
      Effect.andThen(
        run(
          serveArchive,
          new Request("http://localhost/maps/greece.pmtiles", { headers: { range: "bytes=-4" } }),
          (response) =>
            Effect.promise(async () => {
              assert.strictEqual(response.status, 206);
              assert.strictEqual(
                response.headers.get("content-range"),
                `bytes ${ARCHIVE.length - 4}-${ARCHIVE.length - 1}/${ARCHIVE.length}`,
              );
              const body = new Uint8Array(await response.arrayBuffer());
              assert.deepStrictEqual(Array.from(body), Array.from(ARCHIVE.slice(-4)));
            }),
        ),
      ),
    ),
  );

  it.effect("answers 404 for an unknown archive without reading the bucket path", () =>
    run(serveArchive, new Request("http://localhost/maps/missing.pmtiles"), (response, calls) =>
      Effect.promise(async () => {
        assert.strictEqual(response.status, 404);
        assert.deepStrictEqual(calls, [{ key: "maps/missing.pmtiles", range: undefined }]);
      }),
    ),
  );

  it.effect("rejects a key that is not a maps/*.pmtiles object before touching storage", () =>
    run(serveArchive, new Request("http://localhost/maps/notes.txt"), (response, calls) =>
      Effect.promise(async () => {
        assert.strictEqual(response.status, 404);
        assert.deepStrictEqual(calls, []);
      }),
    ),
  );

  it.effect("turns a driver failure into a fixed 500 that names no key", () =>
    run(
      () => Effect.fail(new R2ReadError({ cause: new Error("bucket down") })),
      new Request("http://localhost/maps/greece.pmtiles"),
      (response) =>
        Effect.promise(async () => {
          assert.strictEqual(response.status, 500);
          const body = await response.text();
          assert.include(body, "The basemap is unavailable.");
          assert.notInclude(body, "greece.pmtiles");
          assert.notInclude(body, "bucket down");
        }),
    ),
  );
});
