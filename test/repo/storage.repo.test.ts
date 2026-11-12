import { StorageRepository, StorageRepositoryLive } from "@/repos/storage.repo";
import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";

const fakeObject = (key: string, size = 0): R2Object =>
  ({
    key,
    version: "1",
    size,
    etag: "etag",
    httpEtag: '"etag"',
    checksums: {},
    uploaded: new Date(0),
    storageClass: "Standard",
    writeHttpMetadata: () => {},
  }) as unknown as R2Object;

interface RecordedDelete {
  readonly key: string;
}

const makeBucket = (
  options: {
    readonly put?: (key: string, value: unknown) => Promise<R2Object | null>;
    readonly get?: (key: string) => Promise<R2ObjectBody | null>;
    readonly delete?: (key: string) => Promise<void>;
  } = {},
) => {
  const putCalls: Array<{ readonly key: string; readonly value: unknown }> = [];
  const deleted: Array<RecordedDelete> = [];

  const bucket = {
    put: async (key: string, value: unknown) => {
      putCalls.push({ key, value });
      if (options.put) return options.put(key, value);
      return fakeObject(key);
    },
    get: async (key: string) => (options.get ? options.get(key) : null),
    delete: async (key: string) => {
      deleted.push({ key });
      if (options.delete) return options.delete(key);
      return undefined;
    },
  } as unknown as R2Bucket;

  return { bucket, putCalls, deleted };
};

const withStorage = <A, E>(bucket: R2Bucket, effect: Effect.Effect<A, E, StorageRepository>) =>
  Effect.provide(effect, StorageRepositoryLive(bucket));

it.effect("put stores the value and returns the bucket object", () => {
  const { bucket, putCalls } = makeBucket();
  return withStorage(
    bucket,
    Effect.gen(function* () {
      const storage = yield* StorageRepository;
      const result = yield* storage.put("photos/room.png", "image-bytes");
      assert.strictEqual(result.key, "photos/room.png");
      assert.deepStrictEqual(putCalls, [{ key: "photos/room.png", value: "image-bytes" }]);
    }),
  );
});

it.effect("put fails with R2UploadError when the bucket rejects", () => {
  const { bucket } = makeBucket({
    put: async () => {
      throw new Error("bucket down");
    },
  });
  return withStorage(
    bucket,
    Effect.gen(function* () {
      const storage = yield* StorageRepository;
      const error = yield* Effect.flip(storage.put("photos/fail.png", "bytes"));
      assert.strictEqual(error._tag, "R2UploadError");
    }),
  );
});

it.effect("put fails with R2UploadError when the bucket returns null", () => {
  const { bucket } = makeBucket({ put: async () => null });
  return withStorage(
    bucket,
    Effect.gen(function* () {
      const storage = yield* StorageRepository;
      const error = yield* Effect.flip(storage.put("photos/null.png", "bytes"));
      assert.strictEqual(error._tag, "R2UploadError");
    }),
  );
});

it.effect("get returns the object, and a missing key is None rather than an error", () => {
  const body = { ...fakeObject("photos/one.png", 3) } as unknown as R2ObjectBody;
  const { bucket } = makeBucket({
    get: async (key) => (key === "photos/one.png" ? body : null),
  });
  return withStorage(
    bucket,
    Effect.gen(function* () {
      const storage = yield* StorageRepository;
      const found = yield* storage.get("photos/one.png", undefined);
      assert.isTrue(Option.isSome(found));
      assert.strictEqual(Option.getOrThrow(found).key, "photos/one.png");

      const missing = yield* storage.get("photos/missing.png", undefined);
      assert.isTrue(Option.isNone(missing));
    }),
  );
});

it.effect("get fails with R2ReadError when the bucket rejects", () => {
  const { bucket } = makeBucket({
    get: async () => {
      throw new Error("bucket down");
    },
  });
  return withStorage(
    bucket,
    Effect.gen(function* () {
      const storage = yield* StorageRepository;
      const error = yield* Effect.flip(storage.get("photos/fail.png", undefined));
      assert.strictEqual(error._tag, "R2ReadError");
    }),
  );
});

it.effect("delete removes the key and fails with R2DeleteError when the bucket rejects", () => {
  const { bucket, deleted } = makeBucket();
  return withStorage(
    bucket,
    Effect.gen(function* () {
      const storage = yield* StorageRepository;
      yield* storage.delete("photos/gone.png");
      assert.deepStrictEqual(deleted, [{ key: "photos/gone.png" }]);
    }),
  );
});

it.effect("delete fails with R2DeleteError when the bucket rejects", () => {
  const { bucket } = makeBucket({
    delete: async () => {
      throw new Error("bucket down");
    },
  });
  return withStorage(
    bucket,
    Effect.gen(function* () {
      const storage = yield* StorageRepository;
      const error = yield* Effect.flip(storage.delete("photos/fail.png"));
      assert.strictEqual(error._tag, "R2DeleteError");
    }),
  );
});
