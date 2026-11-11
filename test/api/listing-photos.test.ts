import { asObject, call, multipart, query, register, send, storageEntries } from "../support/api";
import type { TestUser, UploadFile } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

/*
 * The listing photo gallery, driven through the real private and public routers
 * over the in-memory database and the in-memory bucket in `test/support/api.ts`.
 * Every mutating route is reached exactly as a browser's form post would reach
 * it, so authentication, same-origin, ownership, and server-side file validation
 * all run for real.
 */

const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0];
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const imageBytes = (header: ReadonlyArray<number>, length = 32): Uint8Array => {
  const bytes = new Uint8Array(length);
  bytes.set(header);
  for (let index = header.length; index < length; index += 1) bytes[index] = index % 251;
  return bytes;
};

const jpeg = (name = "room.jpg", length = 32): UploadFile => ({
  name,
  contentType: "image/jpeg",
  bytes: imageBytes(JPEG_HEADER, length),
});

const png = (name = "room.png", length = 32): UploadFile => ({
  name,
  contentType: "image/png",
  bytes: imageBytes(PNG_HEADER, length),
});

const wepb = (name = "room.webp"): UploadFile => {
  const bytes = imageBytes([0x52, 0x49, 0x46, 0x46], 24);
  // RIFF....WEBP
  bytes.set([0x24, 0x00, 0x00, 0x00], 4);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  return { name, contentType: "image/webp", bytes };
};

const owner = await Effect.runPromise(register("photo-owner"));
const other = await Effect.runPromise(register("photo-other"));

let priceCounter = 0;
const uniquePriceMinor = () => 500_000 + (priceCounter += 1) * 137;

const createListing = (user: TestUser = owner) =>
  Effect.gen(function* () {
    const response = yield* send("POST", "/api/listings", {
      cookie: user.cookie,
      payload: {
        kind: "room",
        title: "A room with photos",
        description: "Bright and quiet",
        priceMinor: uniquePriceMinor(),
        regionCode: "attica",
        sizeSqm: 35,
      },
    });
    assert.strictEqual(response.status, 200, `create listing: ${response.body}`);
    return Number(asObject(response.json).id);
  });

const publish = (id: number) =>
  Effect.gen(function* () {
    const response = yield* send("POST", `/api/listings/${id}/publish`, { cookie: owner.cookie });
    assert.strictEqual(response.status, 200, `publish: ${response.body}`);
  });

interface PhotoRow {
  readonly id: number;
  readonly listingId: number;
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly position: number;
}

const photosOf = (id: number) =>
  query<PhotoRow>(
    "SELECT id, listing_id AS listingId, storage_key AS storageKey, content_type AS contentType, byte_size AS byteSize, position FROM listing_photos WHERE listing_id = ? ORDER BY position ASC, id ASC",
    [id],
  );

const upload = (id: number, files: ReadonlyArray<UploadFile>, user: TestUser = owner) =>
  call(
    `/listings/${id}/photos`,
    multipart({ method: "POST", headers: { cookie: user.cookie } }, files),
  );

const postForm = (path: string, fields: Readonly<Record<string, string>>, user: TestUser) =>
  call(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "estia-tests",
      cookie: user.cookie,
    },
    body: new URLSearchParams(fields).toString(),
  });

describe("POST /listings/:id/photos", () => {
  it.effect("stores uploaded bytes, appends the gallery, and serves the photo", () =>
    Effect.gen(function* () {
      const id = yield* createListing();
      const response = yield* upload(id, [jpeg(), png()]);
      assert.strictEqual(response.status, 303, response.body);
      assert.strictEqual(response.location, `/listings/${id}/edit`);

      const photos = yield* photosOf(id);
      assert.lengthOf(photos, 2);
      const first = photos[0];
      const second = photos[1];
      assert.isDefined(first);
      assert.isDefined(second);
      assert.strictEqual(first?.position, 0);
      assert.strictEqual(second?.position, 1);
      assert.strictEqual(first?.contentType, "image/jpeg");
      assert.strictEqual(second?.contentType, "image/png");
      // The key is generated server-side from the listing id and a random uuid.
      assert.match(first?.storageKey ?? "", new RegExp(`^listings/${id}/photos/[0-9a-f-]+\\.jpg$`));
      assert.match(
        second?.storageKey ?? "",
        new RegExp(`^listings/${id}/photos/[0-9a-f-]+\\.png$`),
      );
      assert.strictEqual(first?.byteSize, jpeg().bytes.length);

      // The owner's edit page previews a draft's photos.
      const edit = yield* call(`/listings/${id}/edit`, { headers: { cookie: owner.cookie } });
      assert.strictEqual(edit.status, 200, edit.body);
      assert.include(edit.body, "Photos");
      assert.include(edit.body, `src="/listings/${id}/photos/${String(first?.id)}"`);
      assert.include(edit.body, `src="/listings/${id}/photos/${String(second?.id)}"`);

      // A draft's photo is private: the owner can read it, anyone else 404s.
      const ownerRead = yield* call(`/listings/${id}/photos/${String(first?.id)}`, {
        headers: { cookie: owner.cookie },
      });
      assert.strictEqual(ownerRead.status, 200, ownerRead.body);
      const anonymousDraft = yield* call(`/listings/${id}/photos/${String(first?.id)}`);
      assert.strictEqual(anonymousDraft.status, 404);

      yield* publish(id);

      const publicRead = yield* call(`/listings/${id}/photos/${String(first?.id)}`);
      assert.strictEqual(publicRead.status, 200, publicRead.body);
      assert.strictEqual(publicRead.body, new TextDecoder().decode(jpeg().bytes));

      const detail = yield* call(`/api/listings/${id}`);
      assert.strictEqual(detail.status, 200, detail.body);
      const body = asObject(detail.json);
      assert.strictEqual(body.thumbnailUrl, `/listings/${id}/photos/${String(first?.id)}`);
      assert.lengthOf(body.photos as ReadonlyArray<unknown>, 2);

      const detailPage = yield* call(`/listings/${id}`);
      assert.strictEqual(detailPage.status, 200, detailPage.body);
      assert.include(detailPage.body, "Photos");
      assert.include(detailPage.body, `src="/listings/${id}/photos/${String(first?.id)}"`);

      // The search card uses the same first photo as its thumbnail.
      const search = yield* call(`/api/listings?regionCode=attica`);
      assert.strictEqual(search.status, 200, search.body);
      const item = (search.json as { items: ReadonlyArray<Record<string, unknown>> }).items.find(
        (entry) => entry.id === id,
      );
      assert.isDefined(item);
      assert.strictEqual(item?.thumbnailUrl, `/listings/${id}/photos/${String(first?.id)}`);
    }),
  );

  it.effect("accepts WebP and rejects an empty selection", () =>
    Effect.gen(function* () {
      const id = yield* createListing();
      const webpResponse = yield* upload(id, [wepb()]);
      assert.strictEqual(webpResponse.status, 303, webpResponse.body);

      const empty = yield* upload(id, []);
      assert.strictEqual(empty.status, 400);
      assert.include(empty.body, "Choose at least one photo");
      assert.lengthOf(yield* photosOf(id), 1);
    }),
  );
});

describe("reordering, first-photo selection, and deletion", () => {
  it.effect("moves, promotes, and deletes photos while keeping positions contiguous", () =>
    Effect.gen(function* () {
      const id = yield* createListing();
      const uploaded = yield* upload(id, [jpeg("a.jpg"), png("b.png"), jpeg("c.jpg")]);
      assert.strictEqual(uploaded.status, 303, uploaded.body);

      const [a, b, c] = yield* photosOf(id);
      assert.isDefined(a);
      assert.isDefined(b);
      assert.isDefined(c);

      // Move b up: b, a, c.
      const up = yield* postForm(
        `/listings/${id}/photos/${String(b?.id)}/move`,
        { direction: "up" },
        owner,
      );
      assert.strictEqual(up.status, 303, up.body);
      assert.deepStrictEqual(
        (yield* photosOf(id)).map((photo) => photo.id),
        [b?.id, a?.id, c?.id],
      );

      // c becomes first: c, b, a.
      const first = yield* postForm(`/listings/${id}/photos/${String(c?.id)}/first`, {}, owner);
      assert.strictEqual(first.status, 303, first.body);
      assert.deepStrictEqual(
        (yield* photosOf(id)).map((photo) => photo.id),
        [c?.id, b?.id, a?.id],
      );

      const beforeDelete = yield* photosOf(id);
      const removedKey = beforeDelete.find((photo) => photo.id === b?.id)?.storageKey;
      assert.isString(removedKey);
      assert.include(storageEntries(), removedKey);

      const deleted = yield* postForm(`/listings/${id}/photos/${String(b?.id)}/delete`, {}, owner);
      assert.strictEqual(deleted.status, 303, deleted.body);

      const remaining = yield* photosOf(id);
      assert.deepStrictEqual(
        remaining.map((photo) => [photo.id, photo.position]),
        [
          [c?.id, 0],
          [a?.id, 1],
        ],
      );

      const gone = yield* call(`/listings/${id}/photos/${String(b?.id)}`, {
        headers: { cookie: owner.cookie },
      });
      assert.strictEqual(gone.status, 404);
      // Deleting the row also removes the bytes from storage.
      assert.notInclude(storageEntries(), removedKey);
    }),
  );

  it.effect("a move past either end is a no-op, not an error", () =>
    Effect.gen(function* () {
      const id = yield* createListing();
      yield* upload(id, [jpeg("a.jpg"), jpeg("b.jpg")]);
      const [a, b] = yield* photosOf(id);
      assert.isDefined(a);
      assert.isDefined(b);

      const up = yield* postForm(
        `/listings/${id}/photos/${String(a?.id)}/move`,
        { direction: "up" },
        owner,
      );
      assert.strictEqual(up.status, 303);
      assert.deepStrictEqual(
        (yield* photosOf(id)).map((photo) => photo.id),
        [a?.id, b?.id],
      );

      const down = yield* postForm(
        `/listings/${id}/photos/${String(b?.id)}/move`,
        { direction: "down" },
        owner,
      );
      assert.strictEqual(down.status, 303);
      assert.deepStrictEqual(
        (yield* photosOf(id)).map((photo) => photo.id),
        [a?.id, b?.id],
      );
    }),
  );
});

describe("ownership and authentication on every mutating route", () => {
  it.effect("refuses another account's listing on upload, move, first, and delete", () =>
    Effect.gen(function* () {
      const id = yield* createListing();
      yield* upload(id, [jpeg(), png()]);
      const [first, second] = yield* photosOf(id);
      assert.isDefined(first);
      assert.isDefined(second);

      const foreignUpload = yield* upload(id, [jpeg("intruder.jpg")], other);
      assert.strictEqual(foreignUpload.status, 403);
      assert.include(foreignUpload.body, "belongs to another account");

      const foreignMove = yield* postForm(
        `/listings/${id}/photos/${String(second?.id)}/move`,
        { direction: "up" },
        other,
      );
      assert.strictEqual(foreignMove.status, 403);

      const foreignFirst = yield* postForm(
        `/listings/${id}/photos/${String(second?.id)}/first`,
        {},
        other,
      );
      assert.strictEqual(foreignFirst.status, 403);

      const foreignDelete = yield* postForm(
        `/listings/${id}/photos/${String(first?.id)}/delete`,
        {},
        other,
      );
      assert.strictEqual(foreignDelete.status, 403);

      // Nothing another account asked for happened.
      assert.deepStrictEqual(
        (yield* photosOf(id)).map((photo) => [photo.id, photo.position]),
        [
          [first?.id, 0],
          [second?.id, 1],
        ],
      );

      // A photo id from another listing is refused on the owner's own listing.
      const otherListing = yield* createListing();
      yield* upload(otherListing, [jpeg()]);
      const [otherPhoto] = yield* photosOf(otherListing);
      const crossListing = yield* postForm(
        `/listings/${id}/photos/${String(otherPhoto?.id)}/delete`,
        {},
        owner,
      );
      assert.strictEqual(crossListing.status, 404);
      assert.lengthOf(yield* photosOf(id), 2);
    }),
  );

  it.effect("rejects an anonymous upload before it touches storage or the database", () =>
    Effect.gen(function* () {
      const id = yield* createListing();
      const response = yield* call(
        `/listings/${id}/photos`,
        multipart({ method: "POST" }, [jpeg()]),
      );
      assert.strictEqual(response.status, 401);
      assert.include(response.body, "Sign in");
      assert.lengthOf(yield* photosOf(id), 0);
    }),
  );
});

describe("server-side file validation", () => {
  it.effect(
    "rejects a declared non-image, a mismatched magic-byte type, and an oversized file",
    () =>
      Effect.gen(function* () {
        const id = yield* createListing();

        const wrongType = yield* upload(id, [
          {
            name: "notes.txt",
            contentType: "text/plain",
            bytes: new TextEncoder().encode("hello"),
          },
        ]);
        assert.strictEqual(wrongType.status, 400);
        assert.include(wrongType.body, "JPEG, PNG, or WebP");

        // Declared PNG, but the bytes are a GIF: the magic-byte check refuses it.
        const gif = new Uint8Array([
          0x47,
          0x49,
          0x46,
          0x38,
          0x39,
          0x61,
          ...Array.from({ length: 24 }, () => 0),
        ]);
        const spoofed = yield* upload(id, [
          { name: "spoofed.png", contentType: "image/png", bytes: gif },
        ]);
        assert.strictEqual(spoofed.status, 400);
        assert.include(spoofed.body, "does not look like");

        const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
        oversized.set(PNG_HEADER);
        const tooBig = yield* upload(id, [
          { name: "huge.png", contentType: "image/png", bytes: oversized },
        ]);
        assert.strictEqual(tooBig.status, 400);
        assert.include(tooBig.body, "5 MB");

        assert.lengthOf(yield* photosOf(id), 0);
      }),
  );

  it.effect("caps a listing at ten photos", () =>
    Effect.gen(function* () {
      const id = yield* createListing();
      const ten = Array.from({ length: 10 }, (_, index) => jpeg(`photo-${index}.jpg`));
      const firstTen = yield* upload(id, ten);
      assert.strictEqual(firstTen.status, 303, firstTen.body);
      assert.lengthOf(yield* photosOf(id), 10);

      const eleventh = yield* upload(id, [jpeg("photo-11.jpg")]);
      assert.strictEqual(eleventh.status, 400);
      assert.include(eleventh.body, "at most 10 photos");
      assert.lengthOf(yield* photosOf(id), 10);
    }),
  );
});

describe("the removed unauthenticated upload path", () => {
  it.effect("no longer exposes the anonymous multipart endpoint or its test page", () =>
    Effect.gen(function* () {
      const upload = yield* call("/api/auth/test-post", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      });
      assert.strictEqual(upload.status, 404);

      const page = yield* call("/test");
      assert.strictEqual(page.status, 404);
    }),
  );
});

describe("a listing with no photo still renders", () => {
  it.effect("keeps the detail page and the search card readable without a gallery", () =>
    Effect.gen(function* () {
      const id = yield* createListing();
      yield* publish(id);

      const detail = yield* call(`/listings/${id}`);
      assert.strictEqual(detail.status, 200, detail.body);
      assert.include(detail.body, "A room with photos");
      assert.notInclude(detail.body, "Photos");

      const api = yield* call(`/api/listings/${id}`);
      const body = asObject(api.json);
      assert.isNull(body.thumbnailUrl);
      assert.deepStrictEqual(body.photos, []);

      const search = yield* call(`/api/listings?regionCode=attica`);
      const item = (search.json as { items: ReadonlyArray<Record<string, unknown>> }).items.find(
        (entry) => entry.id === id,
      );
      assert.isDefined(item);
      assert.isNull(item?.thumbnailUrl);
      assert.deepStrictEqual(item?.photos, []);
    }),
  );
});
