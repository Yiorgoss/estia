import { MultipartError } from "@effect/platform/Multipart";
import { Chunk, Context, DateTime, Effect, Layer, Schema, Sink, Stream } from "effect";

class R2UploadError extends Schema.TaggedError<R2UploadError>()("R2UploadError", {
  cause: Schema.Unknown
}) { }
class R2MultipartKeyError extends Schema.TaggedError<R2MultipartKeyError>()("R2MultipartKeyError", {
  cause: Schema.Unknown
}) { }
class R2MultipartUploadError extends Schema.TaggedError<R2MultipartUploadError>()("R2MultipartUploadError", {
  cause: Schema.Unknown
}) { }

class R2FileStreamError extends Schema.TaggedError<R2FileStreamError>()("R2FileStreamError", {
  cause: Schema.Unknown
}) { }

export interface StorageRepository {
  readonly put: (key: string, value: ReadableStream | ArrayBuffer | string) => Effect.Effect<R2Object, R2UploadError>
  readonly newMultipart: (key: string, value: Stream.Stream<Uint8Array, MultipartError>) => Effect.Effect<R2Object, MultipartError | R2MultipartKeyError | R2MultipartUploadError>
  // head(key: string): Promise<R2Object | null>;
  // get(key: string, options: R2GetOptions & {
  //     onlyIf: R2Conditional | Headers;
  // }): Promise<R2ObjectBody | R2Object | null>;
  // get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
  // put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, options?: R2PutOptions & {
  //     onlyIf: R2Conditional | Headers;
  // }): Promise<R2Object | null>;
  // put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, options?: R2PutOptions): Promise<R2Object>;
  // createMultipartUpload(key: string, options?: R2MultipartOptions): Promise<R2MultipartUpload>;
  // resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
  // delete(keys: string | string[]): Promise<void>;
  // list(options?: R2ListOptions): Promise<R2Objects>;
}

export const StorageRepository = Context.GenericTag<StorageRepository>("StorageRepository");

export const StorageRepositoryLive = (bucket: R2Bucket) =>
  Layer.effect(StorageRepository,
    Effect.gen(function*() {
      return {

        put: (key, value) => Effect.tryPromise({
          try: () => bucket.put(key, value),
          catch: (e) => new R2UploadError({ cause: e })
        }).pipe(
          Effect.filterOrFail(
            result => !!result,
            () => new R2UploadError({ cause: "Preconditions Failed" })
          )
        ),
        newMultipart: (key, stream) =>
          Effect.gen(function*() {
            yield* Effect.logInfo(`Starting upload: ${key}`)
            const r2 = yield* Effect.tryPromise({
              try: () => bucket.createMultipartUpload(key),
              catch: (e) => new R2MultipartKeyError({ cause: e })
            })
            const bufferSize = 10_000_000 //5 * 1024 * 1024 //5mb

            let remaining = bufferSize
            return yield* stream.pipe(
              // Stream.tap(x => Effect.log("lenght of each new chunk", x.length)),
              Stream.mapAccum(
                { remainder: Buffer.alloc(0), length: 0 },
                (state, chunk) => {
                  const newLength = state.length + chunk.length
                  if (newLength > bufferSize) {
                    const overdraft = bufferSize - newLength //to count from back of buffer:w

                    const keep = chunk.slice(0, overdraft)
                    const remainder = Buffer.from(chunk.subarray(overdraft))
                    const emit = Buffer.concat([state.remainder, keep])
                    return [{ remainder, length: overdraft }, emit]
                  }
                  const newState = { remainder: Buffer.concat([state.remainder, chunk]), length: newLength }
                  return [newState, Buffer.alloc(0)]
                },
              ),
              Stream.filter(x => x.length > 0),
              Stream.tap(x => Effect.log('length after accum', x.length)),
              Stream.zipWithIndex,
              Stream.mapEffect(([bytes, idx]) =>
                Effect.gen(function*() {
                  // if (idx >= 2) throw new R2MultipartKeyError({ cause: "test" })
                  // console.log({ length: bytes.length, idx })

                  const part = yield* Effect.tryPromise({
                    try: () => r2.uploadPart(idx + 1, bytes),
                    catch: (e) => new R2MultipartUploadError({ cause: `Upload Part Error: ${e}` })
                  }).pipe(
                    Effect.timed,
                    Effect.tap(([duration, part]) =>
                      Effect.logInfo(`Uploaded Part: ${part.partNumber} - ${bytes.byteLength} ${bytes.length} in ${duration}`)
                    ),
                    Effect.map(([_, part]) => part)
                  )
                  return part
                }),
                // { concurrency: 4 } //more seems to crash maybe add some retries?
              ),
              Stream.runCollect,
              Effect.map(chunk => Array.from(chunk)),
              Effect.flatMap(parts => Effect.promise(() => r2.complete(parts))),
              Effect.tap(_ => Effect.logInfo(`Finished Uploading: ${key}`))
            )
          })
      }

    })
  )
// get: (key) => Effect.promise(() => bucket.get(key)),
// })
// Stream.rechunk(bufferSize),
//needs better performacne
// Stream.mapConcat(arr => arr), //needs better performacne
// Stream.grouped(bufferSize),
// Stream.map(chunk => Uint8Array.from(chunk)),
// Stream.concat(Stream.make(<Uint8Array | typeof FLUSH>(FLUSH))),
// Stream.mapAccum(
//   Buffer.alloc(bufferSize),
//   (state, chunk) => {
//     if (chunk === FLUSH) return [Buffer.alloc(0), state]

//     const overdraft = state.length + chunk.length - bufferSize
//     console.log({ overdraft })

//     if (overdraft < 0) {
//       const unfinished = Buffer.concat([state, chunk])
//       return [unfinished, Buffer.alloc(0)]
//     }
//     const carry = Buffer.concat([chunk.subarray(overdraft), Buffer.alloc(0)])
//     const emit = Buffer.concat([state, chunk.subarray(0, overdraft)])

//     return [carry, emit]

//     // const newBuf = Buffer.alloc(0)
//     // newBuf.set(chunk.slice(overdraft))
//     // return [newBuf, state]
//   }
// ),
//
//
//
//
//
//
//
//
//
// 
// return yield* stream.pipe(
//   // Stream.rechunk(bufferSize),
//   Stream.concat(Stream.make(<Uint8Array | typeof FLUSH>(FLUSH))),
//   Stream.mapAccum(
//     Buffer.alloc(0),
//     (state, chunk) => {
//       if (chunk === FLUSH) return [Buffer.alloc(0), state]
//       if (chunk.length > bufferSize) throw new Error()

//       const overdraft = state.length + chunk.length - bufferSize

//       if (overdraft < 0) {
//         console.log({ overdraft, byte: chunk.length, state: state.length })
//         const unfinished = Buffer.concat([state, chunk])
//         return [unfinished, Buffer.alloc(0)]
//       }
//       const carry = Buffer.concat([chunk.subarray(overdraft), Buffer.alloc(0)])
//       const emit = Buffer.concat([state, chunk.subarray(0, overdraft)])

//       return [carry, emit]
//     }
//   ),
//   Stream.filter(x => x.length > 0),
//   Stream.zipWithIndex,
//   Stream.mapEffect(([bytes, idx]) =>
//     Effect.gen(function*() {
//       if (idx >= 2) throw new R2MultipartKeyError({ cause: "test" })

//       console.log({ length: bytes.length })
//       const part = yield* Effect.tryPromise({
//         try: () => r2.uploadPart(idx + 1, bytes),
//         catch: (e) => new R2MultipartUploadError({ cause: `Upload Part Error: ${e}` })
//       }).pipe(
//         Effect.timed,
//         Effect.tap(([duration, part]) =>
//           Effect.logInfo(`Uploaded Part: ${part.partNumber} - ${bytes.byteLength} ${bytes.length} in ${duration}`)
//         ),
//         Effect.map(([_, part]) => part)
//       )
//       return part
//     }),
//     { concurrency: 4 } //more seems to crash maybe add some retries?
//   ),
//   Stream.runCollect,
//   Effect.map(chunk => Array.from(chunk)),
//   Effect.flatMap(parts => Effect.promise(() => r2.complete(parts))),
//   Effect.tap(_ => Effect.logInfo(`Finished Uploading: ${key}`))
// )
