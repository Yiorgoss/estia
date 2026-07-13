import { Context, Effect, Layer, Option, Schema } from "effect"
import { CloudflareBindings } from "./cf-bindings"
import { StorageError } from "../errors"

/**
 * Object Storage Service Interface
 */
export interface ObjectStorageService {
  /**
   * Get an object by key
   */
  readonly get: (
    key: string
  ) => Effect.Effect<Option.Option<R2ObjectBody>, StorageError>

  /**
   * Get object metadata without downloading the body
   */
  readonly head: (
    key: string
  ) => Effect.Effect<Option.Option<R2Object>, StorageError>

  /**
   * Put an object
   */
  readonly put: (
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options?: R2PutOptions
  ) => Effect.Effect<R2Object, StorageError>

  /**
   * Delete an object
   */
  readonly delete: (key: string) => Effect.Effect<void, StorageError>

  /**
   * Delete multiple objects
   */
  readonly deleteMany: (keys: string[]) => Effect.Effect<void, StorageError>

  /**
   * List objects
   */
  readonly list: (
    options?: R2ListOptions
  ) => Effect.Effect<
    {
      objects: R2Object[]
      truncated: boolean
      cursor?: string
    },
    StorageError
  >

  /**
   * Check if an object exists
   */
  readonly exists: (key: string) => Effect.Effect<boolean, StorageError>

  /**
   * Get object as text
   */
  readonly getText: (
    key: string
  ) => Effect.Effect<Option.Option<string>, StorageError>

  /**
   * Get object as JSON with schema validation
   */
  readonly getJson: <A, I, R>(
    key: string,
    schema: Schema.Schema<A, I, R>
  ) => Effect.Effect<Option.Option<A>, StorageError, R>

  /**
   * Put JSON object
   */
  readonly putJson: <A>(
    key: string,
    value: A,
    options?: Omit<R2PutOptions, "httpMetadata">
  ) => Effect.Effect<R2Object, StorageError>
}

/**
 * Object Storage Tag
 */
export class ObjectStorage extends Context.Tag("ObjectStorage")<
  ObjectStorage,
  ObjectStorageService
>() { }

/**
 * Cloudflare R2 Implementation
 *
 * @param bindingName - The name of the R2 binding in wrangler.toml
 */
export const ObjectStorageR2 = (
  bindingName: keyof CloudflareBindings["Type"]["env"]
) =>
  Layer.effect(
    ObjectStorage,
    Effect.gen(function*() {
      const { env } = yield* CloudflareBindings
      const r2 = env[bindingName] as R2Bucket

      return ObjectStorage.of({
        get: (key: string) =>
          Effect.tryPromise({
            try: () => r2.get(key),
            catch: (error) =>
              new StorageError({
                operation: "get",
                key,
                message: `Failed to get object "${key}"`,
                cause: error,
              }),
          }).pipe(Effect.map(Option.fromNullable)),

        head: (key: string) =>
          Effect.tryPromise({
            try: () => r2.head(key),
            catch: (error) =>
              new StorageError({
                operation: "head",
                key,
                message: `Failed to get object metadata "${key}"`,
                cause: error,
              }),
          }).pipe(Effect.map(Option.fromNullable)),

        put: (key: string, value, options) =>
          Effect.tryPromise({
            try: () => r2.put(key, value, options),
            catch: (error) =>
              new StorageError({
                operation: "put",
                key,
                message: `Failed to put object "${key}"`,
                cause: error,
              }),
          }),

        delete: (key: string) =>
          Effect.tryPromise({
            try: () => r2.delete(key),
            catch: (error) =>
              new StorageError({
                operation: "delete",
                key,
                message: `Failed to delete object "${key}"`,
                cause: error,
              }),
          }),

        deleteMany: (keys: string[]) =>
          Effect.tryPromise({
            try: () => r2.delete(keys),
            catch: (error) =>
              new StorageError({
                operation: "deleteMany",
                message: `Failed to delete ${keys.length} objects`,
                cause: error,
              }),
          }),

        list: (options) =>
          Effect.tryPromise({
            try: () => r2.list(options),
            catch: (error) =>
              new StorageError({
                operation: "list",
                message: "Failed to list objects",
                cause: error,
              }),
          }),

        exists: (key: string) =>
          Effect.gen(function*() {
            const obj = yield* ObjectStorage.head(key)
            return Option.isSome(obj)
          }),

        getText: (key: string) =>
          Effect.gen(function*() {
            const obj = yield* ObjectStorage.get(key)

            if (Option.isNone(obj)) {
              return Option.none()
            }

            const text = yield* Effect.tryPromise({
              try: () => obj.value.text(),
              catch: (error) =>
                new StorageError({
                  operation: "getText",
                  key,
                  message: `Failed to read text from "${key}"`,
                  cause: error,
                }),
            })

            return Option.some(text)
          }),

        getJson: <A, I, R>(key: string, schema: Schema.Schema<A, I, R>) =>
          Effect.gen(function*() {
            const text = yield* ObjectStorage.getText(key)

            if (Option.isNone(text)) {
              return Option.none()
            }

            let parsed: unknown
            try {
              parsed = JSON.parse(text.value)
            } catch (error) {
              return yield* Effect.fail(
                new StorageError({
                  operation: "getJson",
                  key,
                  message: `Invalid JSON in object "${key}"`,
                  cause: error,
                })
              )
            }

            const decoded = yield* Schema.decodeUnknown(schema)(parsed).pipe(
              Effect.mapError(
                (error) =>
                  new StorageError({
                    operation: "getJson",
                    key,
                    message: `Schema validation failed: ${error}`,
                    cause: error,
                  })
              )
            )

            return Option.some(decoded)
          }),

        putJson: <A>(key: string, value: A, options) =>
          Effect.gen(function*() {
            const json = JSON.stringify(value)

            return yield* ObjectStorage.put(key, json, {
              ...options,
              httpMetadata: {
                ...options?.httpMetadata,
                contentType: "application/json",
              },
            })
          }),
      })
    })
  ).pipe(Layer.provide(CloudflareBindings.Default))

/**
 * Default Object Storage Layer (using MY_BUCKET binding)
 */
ObjectStorage.Default = ObjectStorageR2("STORAGE")
