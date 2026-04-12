import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import {
  Effect,
  Layer,
  Match,
  pipe,
  Schedule,
  Schema as S,
  Stream,
  Array,
  Option,
  flow,
} from "effect"
import {
  SourceSeason,
  SourceStream,
  SourceStreamWithFile,
} from "../Domain/SourceStream.ts"
import type { VideoQuery } from "../Domain/VideoQuery.ts"
import { Sources } from "../Sources.ts"
import { magnetFromHash, qualityFromTitle } from "../Utils.ts"
import {
  Persistable,
  PersistedCache,
  RateLimiter,
} from "effect/unstable/persistence"
import { PersistenceLayer } from "../Persistence.ts"

export const SourceTpbLive = Effect.gen(function* () {
  const sources = yield* Sources
  const limiter = yield* RateLimiter.RateLimiter
  const defaultClient = (yield* HttpClient.HttpClient).pipe(
    HttpClient.tap(
      Effect.fn(function* (r) {
        if (r.status !== 429) return
        yield* Effect.log(r.headers)
      }),
    ),
    HttpClient.withRateLimiter({
      limiter,
      key: "Tpb",
      disableResponseInspection: true,
      window: { seconds: 60 },
      limit: 10,
    }),
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({
      times: 5,
      schedule: Schedule.exponential(100),
    }),
  )
  const client = defaultClient.pipe(
    HttpClient.mapRequest(
      flow(
        HttpClientRequest.prependUrl("https://apibay.org"),
        HttpClientRequest.setHeaders({
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
          "Cache-Control": "max-age=0",
        }),
      ),
    ),
  )

  class SearchRequest extends Persistable.Class<{
    payload: { imdbId: string }
  }>()("Tpb.SearchRequest", {
    primaryKey: (_) => _.imdbId,
    success: SearchResult.Array,
  }) {}
  const search = yield* PersistedCache.make(
    ({ imdbId }: SearchRequest) =>
      client.get("/q.php", { urlParams: { q: imdbId } }).pipe(
        Effect.tapErrorTag(
          "HttpClientError",
          Effect.fn(function* (error) {
            if (error.reason._tag !== "StatusCodeError") return
            if (error.response!.status !== 429) return
            yield* Effect.log(error.response?.headers)
          }),
        ),
        Effect.flatMap(SearchResult.decodeResponse),
        Effect.orDie,
        Effect.map((results) => (results[0].id === "0" ? [] : results)),
        Effect.withSpan("Source.Tpb.search", {
          attributes: { imdbId },
        }),
      ),
    {
      storeId: "Tpb.search",
      timeToLive: (exit) => {
        if (exit._tag === "Failure") return "5 minutes"
        return exit.value.length > 0 ? "3 days" : "6 hours"
      },
      inMemoryCapacity: 8,
    },
  )

  const files = (id: string) =>
    client.get("/f.php", { urlParams: { id } }).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(File.Array)),
      Effect.orElseSucceed(() => []),
      Effect.withSpan("Source.Tpb.files", {
        attributes: { id },
      }),
    )

  yield* sources.register({
    name: "Tpb",
    list: Match.type<VideoQuery>().pipe(
      Match.tag("ImdbSeasonQuery", (query) => {
        if (Option.isNone(query.titleMatcher)) return Stream.empty
        const titleMatcher = query.titleMatcher.value
        return pipe(
          search.get(new SearchRequest({ imdbId: query.imdbId })),
          Effect.map(Array.filter((_) => titleMatcher(_.name))),
          Stream.fromIterableEffect,
          Stream.flatMap(
            (result) =>
              pipe(
                files(result.id),
                Effect.map(
                  (files): Array<SourceSeason | SourceStreamWithFile> =>
                    Array.match(files, {
                      onEmpty: () => [result.asSeason],
                      onNonEmpty: (files) =>
                        Array.map(
                          files,
                          (file, index) =>
                            new SourceStreamWithFile({
                              source: "TPB",
                              title: file.name[0],
                              infoHash: result.info_hash,
                              magnetUri: magnetFromHash(result.info_hash),
                              quality: qualityFromTitle(file.name[0]),
                              seeds: result.seeders,
                              peers: result.leechers,
                              sizeBytes: file.size[0],
                              fileNumber: index,
                            }),
                        ),
                    }),
                ),
                Stream.fromIterableEffect,
              ),
            { concurrency: "unbounded" },
          ),
          Stream.orDie,
          Stream.withSpan("Source.Tpb.Imdb season", {
            attributes: { query },
          }),
        )
      }),
      Match.tag("ImbdMovieQuery", "ImdbSeriesQuery", (query) =>
        search.get(new SearchRequest({ imdbId: query.imdbId })).pipe(
          Effect.map(Array.map((result) => result.asStream)),
          Effect.tapCause(Effect.logDebug),
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
}).pipe(
  Layer.effectDiscard,
  Layer.provide([
    Sources.layer,
    PersistenceLayer,
    RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
  ]),
)

// schemas

export class SearchResult extends S.Class<SearchResult>("SearchResult")({
  id: S.String,
  name: S.String,
  info_hash: S.String,
  leechers: S.FiniteFromString,
  seeders: S.FiniteFromString,
  num_files: S.String,
  size: S.FiniteFromString,
  username: S.String,
  added: S.String,
  category: S.String,
  imdb: S.String,
}) {
  static Array = S.Array(SearchResult)
  static decodeResponse = HttpClientResponse.schemaBodyJson(this.Array)

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
class File extends S.Class<File>("File")({
  name: S.NonEmptyArray(S.String),
  size: S.NonEmptyArray(S.Number),
}) {
  static Array = S.Array(File)
}
