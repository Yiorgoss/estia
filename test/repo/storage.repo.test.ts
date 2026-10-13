import { assert, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { StorageRepository, StorageRepositoryLive } from "@/repo/storage.repo"

const fakeObject = (key: string, size = 0): R2Object =>
  ({
    key,
    version: "1",
    size,
    etag: "etag",
    httpEtag: "\"etag\"",
    checksums: {},
    uploaded: new Date(0),
    storageClass: "Standard",
    writeHttpMetadata: () => {},
  }) as unknown as R2Object

const byteLengthOf = (value: ArrayBuffer | ArrayBufferView | string | Blob): number => {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength
  if (value instanceof ArrayBuffer) return value.byteLength
  if (ArrayBuffer.isView(value)) return value.byteLength
  return 0
}

const PART_SIZE = 10_000_000

interface RecordedUpload {
  readonly key: string
  readonly parts: Array<{ readonly partNumber: number; readonly byteLength: number }>
  completed: boolean
}

const makeBucket = (
  options: {
    readonly put?: (key: string, value: unknown) => Promise<R2Object | null>
    readonly failCreateKey?: string
    readonly failPartNumber?: number
  } = {},
) => {
  const putCalls: Array<{ readonly key: string; readonly value: unknown }> = []
  const uploads: Array<RecordedUpload> = []

  const bucket = {
    put: async (key: string, value: unknown) => {
      putCalls.push({ key, value })
      if (options.put) return options.put(key, value)
      return fakeObject(key)
    },
    createMultipartUpload: async (key: string) => {
      if (options.failCreateKey === key) throw new Error("multipart key rejected")
      const upload: RecordedUpload = { key, parts: [], completed: false }
      uploads.push(upload)
      return {
        key,
        uploadId: `upload-${key}`,
        uploadPart: async (partNumber: number, value: ArrayBuffer | ArrayBufferView | string | Blob) => {
          if (options.failPartNumber === partNumber) throw new Error(`part ${partNumber} rejected`)
          upload.parts.push({ partNumber, byteLength: byteLengthOf(value) })
          return { partNumber, etag: `etag-${partNumber}` }
        },
        abort: async () => {},
        complete: async () => {
          upload.completed = true
          return fakeObject(key, upload.parts.reduce((total, part) => total + part.byteLength, 0))
        },
      }
    },
  } as unknown as R2Bucket

  return { bucket, putCalls, uploads }
}

const withStorage = <A, E>(
  bucket: R2Bucket,
  effect: Effect.Effect<A, E, StorageRepository>,
) => Effect.provide(effect, StorageRepositoryLive(bucket))

it.effect("put stores the value and returns the bucket object", () => {
  const { bucket, putCalls } = makeBucket()
  return withStorage(
    bucket,
    Effect.gen(function*() {
      const storage = yield* StorageRepository
      const result = yield* storage.put("photos/room.png", "image-bytes")
      assert.strictEqual(result.key, "photos/room.png")
      assert.deepStrictEqual(putCalls, [{ key: "photos/room.png", value: "image-bytes" }])
    }),
  )
})

it.effect("put fails with R2UploadError when the bucket rejects", () => {
  const { bucket } = makeBucket({
    put: async () => {
      throw new Error("bucket down")
    },
  })
  return withStorage(
    bucket,
    Effect.gen(function*() {
      const storage = yield* StorageRepository
      const error = yield* Effect.flip(storage.put("photos/fail.png", "bytes"))
      assert.strictEqual(error._tag, "R2UploadError")
    }),
  )
})

it.effect("put fails with R2UploadError when the bucket returns null", () => {
  const { bucket } = makeBucket({ put: async () => null })
  return withStorage(
    bucket,
    Effect.gen(function*() {
      const storage = yield* StorageRepository
      const error = yield* Effect.flip(storage.put("photos/null.png", "bytes"))
      assert.strictEqual(error._tag, "R2UploadError")
    }),
  )
})

it.effect("newMultipart uploads buffered parts in order and completes", () => {
  const { bucket, uploads } = makeBucket()
  return withStorage(
    bucket,
    Effect.gen(function*() {
      const storage = yield* StorageRepository
      const stream = Stream.make(new Uint8Array(PART_SIZE), new Uint8Array(5))
      const result = yield* storage.newMultipart("videos/tour.mp4", stream)

      assert.strictEqual(result.key, "videos/tour.mp4")
      assert.strictEqual(uploads.length, 1)
      assert.isTrue(uploads[0].completed)
      assert.deepStrictEqual(uploads[0].parts, [
        { partNumber: 1, byteLength: PART_SIZE },
        { partNumber: 2, byteLength: 5 },
      ])
      assert.strictEqual(result.size, PART_SIZE + 5)
    }),
  )
})

it.effect("newMultipart fails with R2MultipartKeyError when the upload cannot be created", () => {
  const { bucket } = makeBucket({ failCreateKey: "videos/denied.mp4" })
  return withStorage(
    bucket,
    Effect.gen(function*() {
      const storage = yield* StorageRepository
      const error = yield* Effect.flip(
        storage.newMultipart("videos/denied.mp4", Stream.make(new Uint8Array(4))),
      )
      assert.strictEqual(error._tag, "R2MultipartKeyError")
    }),
  )
})

it.effect("newMultipart fails with R2MultipartUploadError when a part fails", () => {
  const { bucket } = makeBucket({ failPartNumber: 1 })
  return withStorage(
    bucket,
    Effect.gen(function*() {
      const storage = yield* StorageRepository
      const error = yield* Effect.flip(
        storage.newMultipart("videos/broken.mp4", Stream.make(new Uint8Array(PART_SIZE + 1))),
      )
      assert.strictEqual(error._tag, "R2MultipartUploadError")
    }),
  )
})
