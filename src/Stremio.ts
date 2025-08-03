import { Effect, Layer, pipe, ServiceMap } from "effect"
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import type * as Stremio from "stremio-addon-sdk"
import { Sources } from "./Sources.js"
import { configProviderNested } from "./Utils.js"
import { ExtractTag } from "effect/types/Types"
import { Cinemeta } from "./Cinemeta.js"
import { Data, Option, Redacted } from "effect/data"
import { Config, ConfigProvider } from "effect/config"
import { Match } from "effect/match"

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

export class StremioRouter extends ServiceMap.Key<
  StremioRouter,
  HttpRouter.HttpRouter
>()("stremio/StremioRouter") {
  static layer = Layer.effect(StremioRouter)(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter
      const token = yield* Config.Redacted("token")

      return router.prefixed(`/${Redacted.value(token)}`)
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        configProviderNested("addon"),
      ),
    ),
  )
}

const ApiRoutes = Effect.gen(function* () {
  const router = yield* StremioRouter
  const sources = yield* Sources
  const manifest = yield* StremioManifest
  const cinemeta = yield* Cinemeta
  const baseUrl = yield* Config.String("baseUrl").pipe(
    Config.map((url) => new URL(url)),
    Config.option,
  )
  const token = yield* Config.Redacted("token")
  const scope = yield* Effect.scope

  yield* router.addAll([
    HttpRouter.route(
      "GET",
      "/manifest.json",
      Effect.succeed(HttpServerResponse.unsafeJson(manifest)),
    ),
    HttpRouter.route(
      "GET",
      "/stream/:type/:id.json",
      Effect.fnUntraced(function* (request) {
        const { type, id } = yield* streamParams
        const streamRequest = Match.value(type).pipe(
          Match.withReturnType<StreamRequest>(),
          Match.when("channel", () => StreamRequest.Channel({ id })),
          Match.when("movie", () => StreamRequest.Movie({ imdbId: id })),
          Match.when("series", () => {
            const [imdbId, season, episode] = id.split(":")
            return StreamRequest.Series({
              imdbId,
              season: +season,
              episode: +episode,
            })
          }),
          Match.when("tv", () => StreamRequest.Tv({ imdbId: id })),
          Match.exhaustive,
        )
        yield* Effect.log("StreamRequest", streamRequest)
        const url = baseUrl.pipe(
          Option.orElse(() => HttpServerRequest.toURL(request)),
          Option.getOrElse(() => new URL("http://localhost:8000")),
          (url) => {
            url.pathname = Redacted.value(token)
            return url
          },
        )
        const list = sources.list(streamRequest, url)
        const streams =
          streamRequest._tag === "Series"
            ? yield* Effect.tap(list, preloadNextEpisode(streamRequest, url))
            : yield* list

        return HttpServerResponse.unsafeJson({
          streams: streams.map((_) => _.asStremio),
        })
      }),
    ),
  ])

  const preloadNextEpisode = (current: StreamRequest.Series, baseUrl: URL) =>
    pipe(
      cinemeta.lookupSeries(current.imdbId),
      Effect.flatMap((series) =>
        series.findEpisode(current.season, current.episode + 1).asEffect(),
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
}).pipe(
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    configProviderNested("addon"),
  ),
  Effect.annotateLogs({ service: "Stremio" }),
  Layer.effectDiscard,
  Layer.provide([Cinemeta.layer, Sources.layer, StremioRouter.layer]),
)

const HealthRoute = HttpRouter.add(
  "GET",
  "/health",
  HttpServerResponse.text("OK"),
).pipe(Layer.provide(HttpRouter.disableLogger))

const AllRoutes = Layer.mergeAll(ApiRoutes, HealthRoute).pipe(
  Layer.provide(HttpRouter.cors()),
)

export class StremioManifest extends ServiceMap.Key<
  StremioManifest,
  Stremio.Manifest
>()("stremio/StremioManifest") {
  static layer = (manifest: Stremio.Manifest) => Layer.succeed(this)(manifest)
  static addon = (manifest: Stremio.Manifest) =>
    AllRoutes.pipe(Layer.provide(this.layer(manifest)))
}
