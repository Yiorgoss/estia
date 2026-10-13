import { Layer } from "effect";
import { HttpMiddleware, HttpServerRequest } from "effect/http"

export const SpanNameMW =
  Layer.succeed(HttpMiddleware.SpanNameGenerator)(
    (request: HttpServerRequest.HttpServerRequest) => {
      let path = request.url
      try {
        const host = request.headers.host ?? "localhost:xxxx"
        const base = `http://${host}`
        const parsedUrl = new URL(request.url, base)
        path = parsedUrl.pathname
      } catch {
        path = '[unparseable_path_name]'
      }
      return `http -> xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx <- ${request.method} ${path}`
    }
  )
