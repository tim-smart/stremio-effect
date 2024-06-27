import { Config, Context, Data, Effect, Layer, Option } from "effect"
import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import * as Stremio from "stremio-addon-sdk"
import { Sources } from "./Sources.js"

export interface AddonConfig {
  readonly manifest: Stremio.Manifest
}

const streamParams = HttpRouter.params as Effect.Effect<{
  readonly type: Stremio.ContentType
  readonly id: string
}>

export type StreamRequest = Data.TaggedEnum<{
  Channel: { readonly id: string }
  Movie: { readonly imdbId: string }
  Series: {
    readonly imdbId: string
    readonly season: number
    readonly episode: number
  }
  Tv: { readonly imdbId: string }
}>
export const StreamRequest = Data.taggedEnum<StreamRequest>()

export class StremioManifest extends Context.Tag("stremio/StremioManifest")<
  StremioManifest,
  Stremio.Manifest
>() {
  static layer = (manifest: Stremio.Manifest) => Layer.succeed(this, manifest)
}

export class StremioRouter extends HttpRouter.Tag(
  "stremio/StremioRouter",
)<StremioRouter>() {}

export const layerAddon = Effect.gen(function* () {
  const sources = yield* Sources
  const manifest = yield* StremioManifest
  const baseUrl = yield* Config.string("BASE_URL").pipe(
    Config.map(url => new URL(url)),
    Config.option,
  )

  return (yield* StremioRouter.router).pipe(
    HttpRouter.get("/health", HttpServerResponse.text("OK")),
    HttpRouter.get("/manifest.json", HttpServerResponse.unsafeJson(manifest)),
    HttpRouter.get(
      "/stream/:type/:id.json",
      streamParams.pipe(
        Effect.map(({ type, id }) => {
          switch (type) {
            case "channel": {
              return StreamRequest.Channel({ id })
            }
            case "movie": {
              return StreamRequest.Movie({ imdbId: id })
            }
            case "series": {
              const [imdbId, season, episode] = id.split(":")
              return StreamRequest.Series({
                imdbId,
                season: +season,
                episode: +episode,
              })
            }
            case "tv": {
              return StreamRequest.Tv({ imdbId: id })
            }
          }
        }),
        Effect.tap(request => Effect.log("StreamRequest", request)),
        Effect.bindTo("streamRequest"),
        Effect.bind("request", () => HttpServerRequest.HttpServerRequest),
        Effect.let("baseUrl", ({ request }) =>
          baseUrl.pipe(
            Option.orElse(() => HttpServerRequest.toURL(request)),
            Option.getOrElse(() => new URL("http://localhost:8000")),
          ),
        ),
        Effect.flatMap(({ streamRequest, baseUrl }) =>
          sources.list(streamRequest, baseUrl),
        ),
        Effect.map(streams =>
          HttpServerResponse.unsafeJson({
            streams: streams.map(_ => _.asStremio),
          }),
        ),
      ),
    ),
    HttpMiddleware.cors(),
    HttpServer.serve(HttpMiddleware.logger),
    HttpServer.withLogAddress,
  )
}).pipe(
  Layer.unwrapEffect,
  Layer.annotateLogs({ service: "Stremio" }),
  Layer.provide(Sources.Live),
  Layer.provide(StremioRouter.Live),
)
