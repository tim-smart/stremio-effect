import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { Effect, Layer, pipe, Schedule } from "effect"
import { SourceStream } from "../Domain/SourceStream.js"
import { VideoQuery } from "../Domain/VideoQuery.js"
import { Sources } from "../Sources.js"
import { qualityFromTitle } from "../Utils.js"
import { TorrentMeta } from "../TorrentMeta.js"
import { Schema as S } from "effect/schema"
import { Data, Filter, Option } from "effect/data"
import { Cache } from "effect/caching"
import { Stream } from "effect/stream"
import { Match } from "effect/match"

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

  class GetPage extends Data.Class<{
    imdbId: string
    page: number
  }> {
    // [PrimaryKey.symbol]() {
    //   return Hash.hash(this).toString()
    // }
  }
  const getPageCache = yield* Cache.makeWith({
    // storeId: "Source.Eztv.getPage",
    lookup: (_: GetPage) =>
      pipe(
        client.get("/get-torrents", {
          urlParams: {
            page: _.page,
            limit: "100",
            imdb_id: _.imdbId.replace("tt", ""),
          },
        }),
        Effect.flatMap(GetTorrents.decodeResponse),
        Effect.orDie,
      ),
    timeToLive: (exit) => {
      if (exit._tag === "Failure") return "1 minute"
      return exit.value.torrents.length > 0 ? "12 hours" : "3 hours"
    },
    capacity: 512,
  })

  const stream = (imdbId: string) =>
    Stream.paginateArrayEffect(1, (page) =>
      pipe(
        Cache.get(getPageCache, new GetPage({ imdbId, page })),
        Effect.map((_) => [
          _.torrents,
          Option.some(page + 1).pipe(
            Option.filter(() => _.torrents.length < _.limit),
          ),
        ]),
      ),
    ).pipe(Stream.catchCause(() => Stream.empty))

  const seasonSources = (torrent: Torrent) =>
    defaultClient.get(torrent.torrent_url).pipe(
      Effect.flatMap((res) => res.arrayBuffer),
      Effect.flatMap((buffer) => torrentMeta.parse(buffer)),
      Effect.map((meta) =>
        Stream.fromIterable(
          meta.streams({
            source: "EZTV",
            seeds: torrent.seeds,
            peers: torrent.peers,
          }),
        ),
      ),
      Effect.catchCause(() => Effect.succeed(Stream.empty)),
      Effect.withSpan("Source.Eztv.seasonSources", {
        attributes: { title: torrent.title, hash: torrent.hash },
      }),
      Stream.unwrap,
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
              Stream.fromEffect,
              Stream.drain,
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
              Stream.fromEffect,
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
}).pipe(Layer.effectDiscard, Layer.provide([Sources.layer, TorrentMeta.layer]))

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
