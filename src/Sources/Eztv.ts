import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { Effect, Layer, Match, pipe, Schedule } from "effect"
import { SourceStream } from "../Domain/SourceStream.js"
import { VideoQuery } from "../Domain/VideoQuery.js"
import { Sources } from "../Sources.js"
import { qualityFromTitle } from "../Utils.js"
import { TorrentMeta } from "../TorrentMeta.js"
import { Schema as S } from "effect/schema"
import { Filter, Option } from "effect/data"
import { Stream } from "effect/stream"
import { Persistable, PersistedCache } from "effect/unstable/persistence"
import { PersistenceLayer } from "../Persistence.js"

export const SourceEztvLive = Effect.gen(function* () {
  const torrentMeta = yield* TorrentMeta
  const sources = yield* Sources
  const defaultClient = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({
      times: 5,
      schedule: Schedule.exponential(100),
    }),
  )
  const client = defaultClient.pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl("https://eztvx.to/api")),
  )

  const getPage = (imdbId: string, page: number) =>
    pipe(
      client.get("/get-torrents", {
        urlParams: {
          page,
          limit: "100",
          imdb_id: imdbId,
        },
      }),
      Effect.flatMap(GetTorrents.decodeResponse),
      Effect.orDie,
    )

  class GetPage extends Persistable.Class<{
    payload: { imdbId: string; page: number }
  }>()("Eztv.GetPage", {
    primaryKey: (_) => `${_.imdbId}-${_.page}`,
    success: GetTorrents,
  }) {}

  const getPageCache = yield* PersistedCache.make({
    storeId: "Eztv.pages",
    lookup: ({ imdbId, page }: GetPage) => getPage(imdbId, page),
    timeToLive: (exit) => {
      if (exit._tag === "Failure") return "1 minute"
      return exit.value.torrents.length > 0 ? "12 hours" : "3 hours"
    },
    inMemoryCapacity: 16,
  })

  const stream = (imdbId: string, cached = false) =>
    Stream.paginate(1, (page) =>
      pipe(
        cached
          ? getPageCache.get(new GetPage({ imdbId, page }))
          : getPage(imdbId, page),
        Effect.map((_) => [
          _.torrents,
          Option.some(page + 1).pipe(
            Option.filter(() => _.torrents.length < _.limit),
          ),
        ]),
      ),
    ).pipe(Stream.ignoreCause)

  const seasonSources = (torrent: Torrent) =>
    defaultClient.get(torrent.torrent_url).pipe(
      Effect.flatMap((res) => res.arrayBuffer),
      Effect.flatMap((buffer) => torrentMeta.parse(buffer)),
      Effect.map((meta) =>
        meta.streams({
          source: "EZTV",
          seeds: torrent.seeds,
          peers: torrent.peers,
        }),
      ),
      Effect.withSpan("Source.Eztv.seasonSources", {
        attributes: { title: torrent.title, hash: torrent.hash },
      }),
      Stream.fromArrayEffect,
      Stream.ignoreCause,
    )

  yield* sources.register({
    name: "Eztv",
    list: Match.type<VideoQuery>().pipe(
      Match.tag("ImdbSeasonQuery", ({ imdbId, season }) =>
        stream(imdbId).pipe(
          Stream.filter((torrent) =>
            torrent.season === season && torrent.episode === 0
              ? torrent
              : Filter.fail(torrent),
          ),
          Stream.flatMap((torrent) => seasonSources(torrent)),
          Stream.catchCause((cause) =>
            Effect.logDebug(cause).pipe(
              Effect.annotateLogs({
                service: "Source.Eztv.Season",
                imdbId,
                season,
              }),
              Stream.fromEffectDrain,
            ),
          ),
          Stream.withSpan("Source.Eztv.list season", {
            attributes: { imdbId, season },
          }),
        ),
      ),
      Match.tag("ImdbSeriesQuery", ({ imdbId, season, episode }) =>
        stream(imdbId).pipe(
          Stream.filter((torrent) =>
            torrent.season === season && torrent.episode === episode
              ? torrent
              : Filter.fail(torrent),
          ),
          Stream.map((torrent) => torrent.asStream),
          Stream.catchCause((cause) =>
            Effect.logDebug(cause).pipe(
              Effect.annotateLogs({
                service: "Source.Eztv.Series",
                imdbId,
                season,
                episode,
              }),
              Stream.fromEffectDrain,
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
}).pipe(
  Layer.effectDiscard,
  Layer.provide([Sources.layer, TorrentMeta.layer, PersistenceLayer]),
)

// schemas

export class Torrent extends S.Class<Torrent>("Torrent")({
  id: S.Number,
  hash: S.String,
  filename: S.String,
  torrent_url: S.String,
  magnet_url: S.String,
  title: S.String,
  imdb_id: S.String,
  season: S.FiniteFromString,
  episode: S.FiniteFromString,
  small_screenshot: S.String,
  large_screenshot: S.String,
  seeds: S.Number,
  peers: S.Number,
  date_released_unix: S.Number,
  size_bytes: S.FiniteFromString,
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
  torrents: S.Array(Torrent),
}) {
  static decodeResponse = HttpClientResponse.schemaBodyJson(this)
}
