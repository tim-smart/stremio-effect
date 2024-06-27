import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import * as S from "@effect/schema/Schema"
import { Chunk, Data, Effect, Layer, Option, Stream } from "effect"
import { SourceStream } from "../Domain/SourceStream.js"
import { Sources } from "../Sources.js"
import { StreamRequest } from "../Stremio.js"
import { cacheWithSpan, qualityFromTitle } from "../Utils.js"

export const SourceEztvLive = Effect.gen(function* () {
  const sources = yield* Sources
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl("https://eztvx.to/api")),
  )

  class GetPage extends Data.Class<{
    imdbId: string
    page: number
  }> {}
  const getPageCache = yield* cacheWithSpan({
    lookup: (_: GetPage) =>
      HttpClientRequest.get("/get-torrents").pipe(
        HttpClientRequest.setUrlParams({
          page: _.page,
          limit: "100",
          imdb_id: _.imdbId.replace("tt", ""),
        }),
        client,
        GetTorrents.decodeResponse,
      ),
    capacity: 4096,
    timeToLive: "12 hours",
  })

  const stream = (imdbId: string) =>
    Stream.paginateChunkEffect(1, page =>
      getPageCache(new GetPage({ imdbId, page })).pipe(
        Effect.map(
          _ =>
            [
              _.torrents,
              Option.some(page + 1).pipe(
                Option.filter(() => _.torrents.length < _.limit),
              ),
            ] as const,
        ),
      ),
    ).pipe(Stream.catchTag("ParseError", () => Stream.empty))

  yield* sources.register({
    list: StreamRequest.$match({
      Channel: () => Effect.succeed([]),
      Series: ({ imdbId, season, episode }) =>
        stream(imdbId).pipe(
          Stream.filter(
            tor => tor.season === season && tor.episode === episode,
          ),
          Stream.map(tor => tor.asStream),
          Stream.runCollect,
          Effect.map(Chunk.toReadonlyArray),
          Effect.tapErrorCause(Effect.logDebug),
          Effect.orElseSucceed(() => []),
          Effect.withSpan("Source.Eztv.list", {
            attributes: { imdbId, season, episode },
          }),
          Effect.annotateLogs({
            service: "Source.Eztv",
            method: "list",
            imdbId,
          }),
        ),
      Movie: () => Effect.succeed([]),
      Tv: () => Effect.succeed([]),
    }),
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
      infoHash: this.hash,
      quality: qualityFromTitle(this.title),
      seeds: this.seeds,
      peers: this.peers,
      magnetUri: this.magnet_url,
      sizeBytes: this.size_bytes,
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
