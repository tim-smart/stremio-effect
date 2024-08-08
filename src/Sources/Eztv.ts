import { PersistedCache } from "@effect/experimental"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Schema } from "@effect/schema"
import * as S from "@effect/schema/Schema"
import {
  Effect,
  Hash,
  Layer,
  Match,
  Option,
  pipe,
  PrimaryKey,
  Schedule,
  Stream,
} from "effect"
import { SourceStream } from "../Domain/SourceStream.js"
import { VideoQuery } from "../Domain/VideoQuery.js"
import { Sources } from "../Sources.js"
import { qualityFromTitle } from "../Utils.js"

export const SourceEztvLive = Effect.gen(function* () {
  const sources = yield* Sources
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl("https://eztvx.to/api")),
    HttpClient.filterStatusOk,
    HttpClient.transformResponse(
      Effect.retry({
        while: err =>
          err._tag === "ResponseError" && err.response.status >= 429,
        times: 5,
        schedule: Schedule.exponential(100),
      }),
    ),
  )

  class GetPage extends Schema.TaggedRequest<GetPage>()("GetPage", {
    failure: Schema.Never,
    success: GetTorrents,
    payload: {
      imdbId: Schema.String,
      page: Schema.Number,
    },
  }) {
    [PrimaryKey.symbol]() {
      return Hash.hash(this).toString()
    }
  }
  const getPageCache = yield* PersistedCache.make({
    storeId: "Source.Eztv.getPage",
    lookup: (_: GetPage) =>
      HttpClientRequest.get("/get-torrents").pipe(
        HttpClientRequest.setUrlParams({
          page: _.page,
          limit: "100",
          imdb_id: _.imdbId.replace("tt", ""),
        }),
        client,
        GetTorrents.decodeResponse,
        Effect.orDie,
      ),
    timeToLive: (_, exit) => {
      if (exit._tag === "Failure") return "1 minute"
      return exit.value.torrents.length > 0 ? "12 hours" : "3 hours"
    },
  })

  const stream = (imdbId: string) =>
    Stream.paginateChunkEffect(1, page =>
      pipe(
        getPageCache.get(new GetPage({ imdbId, page })),
        Effect.map(_ => [
          _.torrents,
          Option.some(page + 1).pipe(
            Option.filter(() => _.torrents.length < _.limit),
          ),
        ]),
      ),
    ).pipe(Stream.catchAllCause(() => Stream.empty))

  yield* sources.register({
    list: Match.type<VideoQuery>().pipe(
      Match.tag("ImdbSeriesQuery", ({ imdbId, season, episode }) =>
        stream(imdbId).pipe(
          Stream.filter(
            tor => tor.season === season && tor.episode === episode,
          ),
          Stream.map(tor => tor.asStream),
          Stream.catchAllCause(cause =>
            Effect.logDebug(cause).pipe(
              Effect.annotateLogs({
                service: "Source.Eztv.Series",
                imdbId,
                season,
                episode,
              }),
              Stream.drain,
            ),
          ),
          Stream.withSpan("Source.Eztv.list", {
            attributes: { imdbId, season, episode },
          }),
        ),
      ),
      Match.orElse(() => Stream.empty),
    ),
  })
}).pipe(Layer.scopedDiscard, Layer.provide(Sources.Live))

// schemas

export class Torrent extends S.Class<Torrent>("Torrent")({
  id: S.Number,
  hash: S.String,
  filename: S.String,
  torrent_url: S.String,
  magnet_url: S.String,
  title: S.String,
  imdb_id: S.String,
  season: S.NumberFromString,
  episode: S.NumberFromString,
  small_screenshot: S.String,
  large_screenshot: S.String,
  seeds: S.Number,
  peers: S.Number,
  date_released_unix: S.Number,
  size_bytes: S.NumberFromString,
}) {
  get asStream() {
    return new SourceStream({
      source: "EZTV",
      title: this.title,
      infoHash: this.hash,
      quality: qualityFromTitle(this.title),
      seeds: this.seeds,
      peers: this.peers,
      magnetUri: this.magnet_url,
      sizeBytes: this.size_bytes,
      verified: true,
    })
  }
}

export class GetTorrents extends S.Class<GetTorrents>("GetTorrents")({
  torrents_count: S.Number,
  limit: S.Number,
  page: S.Number,
  torrents: S.Chunk(Torrent),
}) {
  static decodeResponse = HttpClientResponse.schemaBodyJsonScoped(this)
}
