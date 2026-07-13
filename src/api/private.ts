import { Etag, FileSystem, HttpApi, HttpLayerRouter, HttpPlatform, Path } from "@effect/platform";
import { Layer } from "effect";

export const PrivateApi = HttpApi
  .make("PrivateApi")

export const PrivateApiRouter = HttpLayerRouter
  .addHttpApi(PrivateApi)
  .pipe()
