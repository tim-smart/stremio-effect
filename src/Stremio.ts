import {
  Config,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  pipe,
  Redacted,
} from "effect"
import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import type * as Stremio from "stremio-addon-sdk"
import { Sources } from "./Sources.js"
import { configProviderNested } from "./Utils.js"
import { ExtractTag } from "effect/Types"
import { Cinemeta } from "./Cinemeta.js"

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
export declare namespace StreamRequest {
  export interface Series extends ExtractTag<StreamRequest, "Series"> {}
}
export const StreamRequest = Data.taggedEnum<StreamRequest>()
export const streamRequestId = StreamRequest.$match({
  Channel: ({ id }) => `Channel:${id}`,
  Movie: ({ imdbId }) => `Movie:${imdbId}`,
  Series: ({ imdbId, season, episode }) =>
    `Series:${imdbId}:${season}:${episode}`,
  Tv: ({ imdbId }) => `Tv:${imdbId}`,
})

export class StremioRouter extends HttpRouter.Tag(
  "stremio/StremioRouter",
)<StremioRouter>() {}

export const layerAddon = Effect.gen(function* () {
  const sources = yield* Sources
  const manifest = yield* StremioManifest
  const cinemeta = yield* Cinemeta
  const baseUrl = yield* Config.string("baseUrl").pipe(
    Config.map((url) => new URL(url)),
    Config.option,
  )
  const token = yield* Config.redacted("token")
  const scope = yield* Effect.scope

  const apiRouter = (yield* StremioRouter.router).pipe(
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
        Effect.tap((request) => Effect.log("StreamRequest", request)),
        Effect.bindTo("streamRequest"),
        Effect.bind("request", () => HttpServerRequest.HttpServerRequest),
        Effect.let("baseUrl", ({ request }) =>
          baseUrl.pipe(
            Option.orElse(() => HttpServerRequest.toURL(request)),
            Option.getOrElse(() => new URL("http://localhost:8000")),
            (url) => {
              url.pathname = Redacted.value(token)
              return url
            },
          ),
        ),
        Effect.flatMap(({ streamRequest, baseUrl }) => {
          const list = sources.list(streamRequest, baseUrl)
          return streamRequest._tag === "Series"
            ? Effect.zipLeft(list, preloadNextEpisode(streamRequest, baseUrl))
            : list
        }),
        Effect.map((streams) =>
          HttpServerResponse.unsafeJson({
            streams: streams.map((_) => _.asStremio),
          }),
        ),
      ),
    ),
  )

  const preloadNextEpisode = (current: StreamRequest.Series, baseUrl: URL) =>
    pipe(
      cinemeta.lookupSeries(current.imdbId),
      Effect.flatMap((series) =>
        series.findEpisode(current.season, current.episode + 1),
      ),
      Effect.flatMap((video) =>
        sources.list(
          StreamRequest.Series({
            ...current,
            episode: video.episodeOrNumber,
          }),
          baseUrl,
        ),
      ),
      Effect.ignore,
      Effect.withSpan("Stremio.preloadNextEpisode", {
        attributes: { current },
      }),
      Effect.forkIn(scope),
    )

  return HttpRouter.empty.pipe(
    HttpRouter.get("/health", HttpServerResponse.text("OK")),
    HttpRouter.mount(`/${Redacted.value(token)}`, apiRouter),
    HttpMiddleware.cors(),
    HttpServer.serve(HttpMiddleware.logger),
    HttpServer.withLogAddress,
  )
}).pipe(
  Effect.withConfigProvider(configProviderNested("addon")),
  Layer.unwrapScoped,
  Layer.annotateLogs({ service: "Stremio" }),
  Layer.provide(Sources.Default),
  Layer.provide(Cinemeta.Default),
  Layer.provide(StremioRouter.Live),
)

export class StremioManifest extends Context.Tag("stremio/StremioManifest")<
  StremioManifest,
  Stremio.Manifest
>() {
  static layer = (manifest: Stremio.Manifest) => Layer.succeed(this, manifest)
  static addon = (manifest: Stremio.Manifest) =>
    layerAddon.pipe(Layer.provide(this.layer(manifest)))
}
