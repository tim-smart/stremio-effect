import { PersistedCache } from "@effect/experimental"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Schema } from "effect"
import * as S from "effect/Schema"
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
import { PersistenceLive } from "../Persistence.js"
import { TorrentMeta } from "../TorrentMeta.js"

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
      pipe(
        client.get("/get-torrents", {
          urlParams: {
            page: _.page,
            limit: "100",
            imdb_id: _.imdbId.replace("tt", ""),
          },
        }),
        Effect.flatMap(GetTorrents.decodeResponse),
        Effect.scoped,
        Effect.orDie,
      ),
    timeToLive: (_, exit) => {
      if (exit._tag === "Failure") return "1 minute"
      return exit.value.torrents.length > 0 ? "12 hours" : "3 hours"
    },
  })

  const stream = (imdbId: string) =>
    Stream.paginateChunkEffect(1, (page) =>
      pipe(
        getPageCache.get(new GetPage({ imdbId, page })),
        Effect.map((_) => [
          _.torrents,
          Option.some(page + 1).pipe(
            Option.filter(() => _.torrents.length < _.limit),
          ),
        ]),
      ),
    ).pipe(Stream.catchAllCause(() => Stream.empty))

  const seasonSources = (torrent: Torrent) =>
    defaultClient.get(torrent.torrent_url).pipe(
      Effect.flatMap((res) => res.arrayBuffer),
      Effect.scoped,
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
      Effect.catchAllCause(() => Effect.succeed(Stream.empty)),
      Effect.withSpan("Source.Eztv.seasonSources", {
        attributes: { title: torrent.title, hash: torrent.hash },
      }),
      Stream.unwrap,
    )

  yield* sources.register({
    list: Match.type<VideoQuery>().pipe(
      Match.tag("ImdbSeasonQuery", ({ imdbId, season }) =>
        stream(imdbId).pipe(
          Stream.filter(
            (torrent) => torrent.season === season && torrent.episode === 0,
          ),
          Stream.flatMap((torrent) => seasonSources(torrent)),
          Stream.catchAllCause((cause) =>
            Effect.logDebug(cause).pipe(
              Effect.annotateLogs({
                service: "Source.Eztv.Season",
                imdbId,
                season,
              }),
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
          Stream.filter(
            (torrent) =>
              torrent.season === season && torrent.episode === episode,
          ),
          Stream.map((torrent) => torrent.asStream),
          Stream.catchAllCause((cause) =>
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
}).pipe(
  Layer.scopedDiscard,
  Layer.provide([Sources.Default, PersistenceLive, TorrentMeta.Default]),
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
  static decodeResponse = HttpClientResponse.schemaBodyJson(this)
}
