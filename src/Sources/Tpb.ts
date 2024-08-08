import { PersistedCache } from "@effect/experimental"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Schema } from "@effect/schema"
import * as S from "@effect/schema/Schema"
import {
  Array,
  Effect,
  Hash,
  Layer,
  Match,
  PrimaryKey,
  Schedule,
  Stream,
} from "effect"
import { SourceSeason, SourceStream } from "../Domain/SourceStream.js"
import { VideoQuery } from "../Domain/VideoQuery.js"
import { Sources } from "../Sources.js"
import { magnetFromHash, qualityFromTitle } from "../Utils.js"

export const SourceTpbLive = Effect.gen(function* () {
  const sources = yield* Sources
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl("https://apibay.org")),
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

  class SearchRequest extends Schema.TaggedRequest<SearchRequest>()(
    "SearchRequest",
    {
      failure: Schema.Never,
      success: Schema.Array(SearchResult),
      payload: { imdbId: Schema.String },
    },
  ) {
    [PrimaryKey.symbol]() {
      return Hash.hash(this).toString()
    }
  }

  const search = yield* PersistedCache.make({
    storeId: "Source.Tpb.search",
    lookup: ({ imdbId }: SearchRequest) =>
      HttpClientRequest.get("/q.php", {
        urlParams: { q: imdbId },
      }).pipe(
        client,
        SearchResult.decodeResponse,
        Effect.orDie,
        Effect.map(results => (results[0].id === "0" ? [] : results)),
        Effect.withSpan("Source.Tpb.search", {
          attributes: { imdbId },
        }),
      ),
    timeToLive: (_, exit) => {
      if (exit._tag === "Failure") return "5 minutes"
      return exit.value.length > 0 ? "3 days" : "6 hours"
    },
    inMemoryCapacity: 8,
  })

  yield* sources.register({
    list: Match.type<VideoQuery>().pipe(
      Match.tag("ImbdMovieQuery", "ImdbSeriesQuery", "ImdbSeasonQuery", query =>
        search.get(new SearchRequest({ imdbId: query.imdbId })).pipe(
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
