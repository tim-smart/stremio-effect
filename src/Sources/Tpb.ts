import { PersistedCache } from "@effect/experimental"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import {
  Array,
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
import * as S from "effect/Schema"
import {
  SourceSeason,
  SourceStream,
  SourceStreamWithFile,
} from "../Domain/SourceStream.js"
import { VideoQuery } from "../Domain/VideoQuery.js"
import { PersistenceLive } from "../Persistence.js"
import { Sources } from "../Sources.js"
import { magnetFromHash, qualityFromTitle } from "../Utils.js"
import { PersistenceError } from "@effect/experimental/Persistence"

export const SourceTpbLive = Effect.gen(function* () {
  const sources = yield* Sources
  const defaultClient = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({
      times: 5,
      schedule: Schedule.exponential(100),
    }),
  )
  const client = defaultClient.pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl("https://apibay.org")),
  )

  class SearchRequest extends S.TaggedRequest<SearchRequest>()(
    "SearchRequest",
    {
      failure: S.Never,
      success: S.Array(SearchResult),
      payload: { imdbId: S.String },
    },
  ) {
    [PrimaryKey.symbol]() {
      return Hash.hash(this).toString()
    }
  }

  const search = yield* PersistedCache.make({
    storeId: "Source.Tpb.search",
    lookup: ({ imdbId }: SearchRequest) =>
      client.get("/q.php", { urlParams: { q: imdbId } }).pipe(
        Effect.flatMap(SearchResult.decodeResponse),
        Effect.scoped,
        Effect.orDie,
        Effect.map((results) => (results[0].id === "0" ? [] : results)),
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

  class FilesRequest extends S.TaggedRequest<FilesRequest>()("FilesRequest", {
    failure: S.Never,
    success: File.Array,
    payload: { id: S.String },
  }) {
    [PrimaryKey.symbol]() {
      return Hash.hash(this).toString()
    }
  }

  const files = yield* PersistedCache.make({
    storeId: "Source.Tpb.files",
    lookup: ({ id }: FilesRequest) =>
      client.get("/f.php", { urlParams: { id } }).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(File.Array)),
        Effect.scoped,
        Effect.orElseSucceed(() => []),
        Effect.withUnhandledErrorLogLevel(Option.none()),
        Effect.withSpan("Source.Tpb.files", {
          attributes: { id },
        }),
      ),
    timeToLive: (_, exit) => (exit._tag === "Failure" ? "5 minutes" : "3 days"),
    inMemoryCapacity: 8,
  })

  yield* sources.register({
    list: Match.type<VideoQuery>().pipe(
      Match.tag("ImdbSeasonQuery", (query) =>
        search.get(new SearchRequest({ imdbId: query.imdbId })).pipe(
          Stream.flatMap(Stream.fromIterable),
          Stream.flatMap(
            (
              result,
            ): Stream.Stream<
              Array<SourceSeason | SourceStreamWithFile>,
              PersistenceError
            > =>
              pipe(
                files.get(new FilesRequest({ id: result.id })),
                Effect.map(
                  Array.match({
                    onEmpty: () => [result.asSeason],
                    onNonEmpty: (files) =>
                      files.map(
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
              ),
            { concurrency: "unbounded" },
          ),
          Stream.flatMap(Stream.fromIterable),
          Stream.orDie,
          Stream.withSpan("Source.Tpb.Imdb season", { attributes: { query } }),
        ),
      ),
      Match.tag("ImbdMovieQuery", "ImdbSeriesQuery", (query) =>
        search.get(new SearchRequest({ imdbId: query.imdbId })).pipe(
          Effect.map(Array.map((result) => result.asStream)),
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
}).pipe(Layer.scopedDiscard, Layer.provide([Sources.Default, PersistenceLive]))

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
  static decodeResponse = HttpClientResponse.schemaBodyJson(S.Array(this))

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
