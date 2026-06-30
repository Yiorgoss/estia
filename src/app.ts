import { Layer } from "effect"
import {
  CloudflareBindings,
  Config,
  ConfigLive,
  Database,
  DatabaseD1Live,
  KVStore,
  ObjectStorage,
} from "./services"

/**
 * Application Layer
 *
 * This layer composes all infrastructure services.
 * Services are automatically memoized - each service is instantiated once per request.
 *
 * **Layer Dependencies**:
 * - All infrastructure services depend on CloudflareBindings
 * - CloudflareBindings is provided at runtime creation time
 */
export const AppLive = Layer.mergeAll(
  ConfigLive,
  DatabaseD1Live,
  KVStore.Default, // Uses MY_KV binding
  ObjectStorage.Default, // Uses MY_BUCKET binding
)

/**
 * Application Dependencies Type
 *
 * This type represents all services available in the application.
 */
export type AppDependencies = Layer.Layer.Success<typeof AppLive>
