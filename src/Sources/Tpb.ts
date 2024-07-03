import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Array, Effect, Layer, Match, Stream } from "effect"
import * as S from "@effect/schema/Schema"
import { Sources } from "../Sources.js"
import { cacheWithSpan, magnetFromHash, qualityFromTitle } from "../Utils.js"
import { Schema } from "@effect/schema"
import { VideoQuery } from "../Domain/VideoQuery.js"
import { SourceSeason, SourceStream } from "../Domain/SourceStream.js"

export const SourceTpbLive = Effect.gen(function* () {
  const sources = yield* Sources
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl("https://apibay.org")),
  )

  const search = yield* cacheWithSpan({
    lookup: (imbdId: string) =>
      HttpClientRequest.get("/q.php", {
        urlParams: { q: imbdId },
      }).pipe(
        client,
        SearchResult.decodeResponse,
        Effect.map(results => (results[0].id === "0" ? [] : results)),
        Effect.withSpan("Source.Tpb.search", {
          attributes: { imbdId },
        }),
      ),
    capacity: 4096,
    timeToLive: "12 hours",
  })

  yield* sources.register({
    list: Match.type<VideoQuery>().pipe(
      Match.tag("ImbdMovieQuery", "ImdbSeriesQuery", "ImdbSeasonQuery", query =>
        search(query.imdbId).pipe(
          Effect.map(
            Array.map(result =>
              query._tag === "ImdbSeasonQuery"
                ? result.asSeason
                : result.asStream,
            ),
          ),
          Effect.tapErrorCause(Effect.logDebug),
          Effect.orElseSucceed(() => []),
          Effect.withSpan("Source.Tpb.Imdb", { attributes: { query } }),
          Effect.annotateLogs({
            service: "Source.Tpb",
            method: "list",
            kind: "Imdb",
          }),
          Stream.fromIterableEffect,
        ),
      ),
      Match.orElse(() => Stream.empty),
    ),
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
      title: this.name,
      infoHash: this.info_hash,
      magnetUri: magnetFromHash(this.info_hash),
      quality: qualityFromTitle(this.name),
      seeds: this.seeders,
      peers: this.leechers,
      sizeBytes: this.size,
    })
  }

  get asSeason() {
    return new SourceSeason({
      source: "TPB",
      title: this.name,
      infoHash: this.info_hash,
      magnetUri: magnetFromHash(this.info_hash),
      seeds: this.seeders,
      peers: this.leechers,
    })
  }
}
