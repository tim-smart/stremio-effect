import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Array, Effect, identity, Layer } from "effect"
import * as S from "@effect/schema/Schema"
import { Sources } from "../Sources.js"
import { cacheWithSpan, magnetFromHash, qualityFromTitle } from "../Utils.js"
import { Schema } from "@effect/schema"
import { StreamRequest } from "../Stremio.js"
import { ImdbMovieQuery, ImdbVideoQuery } from "../Domain/VideoQuery.js"
import { Cinemeta } from "../Cinemeta.js"
import { SourceStream } from "../Domain/SourceStream.js"

export const SourceTpbLive = Effect.gen(function* () {
  const sources = yield* Sources
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl("https://apibay.org")),
  )

  const searchCache = yield* cacheWithSpan({
    lookup: (query: ImdbVideoQuery) =>
      HttpClientRequest.get("/q.php", {
        urlParams: { q: query.asQuery },
      }).pipe(
        client,
        SearchResult.decodeResponse,
        Effect.map(results => (results[0].id === "0" ? [] : results)),
      ),
    capacity: 1024,
    timeToLive: "12 hours",
  })

  const search = (query: ImdbVideoQuery) => {
    const matcher = query.titleMatcher
    return searchCache(query).pipe(
      matcher._tag === "Some"
        ? Effect.map(Array.filter(_ => matcher.value(_.name)))
        : identity,
      Effect.withSpan("Source.Tpb.Search", {
        attributes: { query: query.asQuery },
      }),
    )
  }

  const cinemeta = yield* Cinemeta
  yield* sources.register({
    list: StreamRequest.$match({
      Channel: () => Effect.succeed([]),
      Movie: ({ imdbId }) =>
        search(new ImdbMovieQuery({ imdbId })).pipe(
          Effect.map(Array.map(_ => _.asStream)),
          Effect.tapErrorCause(Effect.logDebug),
          Effect.orElseSucceed(() => []),
          Effect.withSpan("Source.Tpb.Movie", { attributes: { imdbId } }),
        ),
      Series: ({ imdbId, season, episode }) =>
        cinemeta.lookupEpisode(imdbId, season, episode).pipe(
          Effect.flatMap(result => search(result.imdbQuery)),
          Effect.map(Array.map(_ => _.asStream)),
          Effect.tapErrorCause(Effect.logDebug),
          Effect.orElseSucceed(() => []),
          Effect.withSpan("Source.Tpb.Series", {
            attributes: { imdbId, season, episode },
          }),
        ),
      Tv: () => Effect.succeed([]),
    }),
  })
}).pipe(
  Layer.scopedDiscard,
  Layer.provide(Sources.Live),
  Layer.provide(Cinemeta.Live),
)

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
