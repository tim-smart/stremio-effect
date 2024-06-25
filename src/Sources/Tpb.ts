import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Array, Effect, Layer, pipe } from "effect"
import * as S from "@effect/schema/Schema"
import { Sources, SourceStream } from "../Sources.js"
import { cacheWithSpan, magnetFromHash, qualityFromTitle } from "../Utils.js"
import { Schema } from "@effect/schema"
import { StreamRequest } from "../Stremio.js"

export const SourceTpbLive = Effect.gen(function* () {
  const sources = yield* Sources
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl("https://apibay.org")),
  )

  const searchCache = yield* cacheWithSpan({
    lookup: (query: string) =>
      HttpClientRequest.get("/q.php", {
        urlParams: { q: query },
      }).pipe(
        client,
        SearchResult.decodeResponse,
        Effect.map(results => (results[0].id === "0" ? [] : results)),
      ),
    capacity: 1024,
    timeToLive: "12 hours",
  })

  const search = (query: string) =>
    pipe(
      searchCache(query),
      Effect.tapErrorCause(Effect.logDebug),
      Effect.orElseSucceed(() => [] as SearchResult[]),
      Effect.withSpan("Source.Tpb.search", { attributes: { query } }),
    )

  yield* sources.register({
    list: StreamRequest.$match({
      Channel: () => Effect.succeed([]),
      Movie: ({ imdbId }) =>
        search(imdbId).pipe(Effect.map(Array.map(_ => _.asStream))),
      Series: ({ imdbId, season, episode }) => {
        const episodeQuery = `S${season.toString().padStart(2, "0")}E${episode.toString().padStart(2, "0")}`
        return search(imdbId).pipe(
          Effect.map(Array.filter(_ => _.name.includes(episodeQuery))),
          Effect.map(Array.map(_ => _.asStream)),
        )
      },
      Tv: () => Effect.succeed([]),
    }),
  })
}).pipe(Layer.scopedDiscard, Layer.provide(Sources.Live))

// schemas

export class SearchResult extends S.Class<SearchResult>("SearchResult")({
  id: S.String,
  name: S.String,
  info_hash: S.String,
  leechers: S.NumberFromString,
  seeders: S.NumberFromString,
  num_files: S.String,
  size: S.NumberFromString,
  username: S.String,
  added: S.String,
  category: S.String,
  imdb: S.String,
}) {
  static decodeResponse = HttpClientResponse.schemaBodyJsonScoped(
    Schema.Array(this),
  )

  get asStream() {
    return new SourceStream({
      source: "TPB",
      infoHash: this.info_hash,
      magnetUri: magnetFromHash(this.info_hash),
      quality: qualityFromTitle(this.name),
      seeds: this.seeders,
      peers: this.leechers,
      sizeBytes: this.size,
    })
  }
}
