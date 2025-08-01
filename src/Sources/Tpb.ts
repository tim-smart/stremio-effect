import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { Effect, Layer, pipe, Schedule } from "effect"
import {
  SourceSeason,
  SourceStream,
  SourceStreamWithFile,
} from "../Domain/SourceStream.js"
import { VideoQuery } from "../Domain/VideoQuery.js"
import { Sources } from "../Sources.js"
import { magnetFromHash, qualityFromTitle } from "../Utils.js"
import { Schema as S } from "effect/schema"
import { Data, Option } from "effect/data"
import { Cache } from "effect/caching"
import { Match } from "effect/match"
import { Array } from "effect/collections"
import { Stream } from "effect/stream"

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

  class SearchRequest extends Data.Class<{ imdbId: string }> {
    // [PrimaryKey.symbol]() {
    //   return Hash.hash(this).toString()
    // }
  }

  const search = yield* Cache.makeWith({
    // storeId: "Source.Tpb.search",
    lookup: ({ imdbId }: SearchRequest) =>
      client.get("/q.php", { urlParams: { q: imdbId } }).pipe(
        Effect.flatMap(SearchResult.decodeResponse),
        Effect.orDie,
        Effect.map((results) => (results[0].id === "0" ? [] : results)),
        Effect.withSpan("Source.Tpb.search", {
          attributes: { imdbId },
        }),
      ),
    timeToLive: (exit) => {
      if (exit._tag === "Failure") return "5 minutes"
      return exit.value.length > 0 ? "3 days" : "6 hours"
    },
    capacity: 128,
  })

  class FilesRequest extends Data.Class<{ id: string }> {
    // [PrimaryKey.symbol]() {
    //   return Hash.hash(this).toString()
    // }
  }

  const files = yield* Cache.makeWith({
    // storeId: "Source.Tpb.files",
    lookup: ({ id }: FilesRequest) =>
      client.get("/f.php", { urlParams: { id } }).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(File.Array)),
        Effect.orElseSucceed(() => []),
        Effect.withSpan("Source.Tpb.files", {
          attributes: { id },
        }),
      ),
    timeToLive: (exit) => (exit._tag === "Failure" ? "5 minutes" : "3 days"),
    capacity: 128,
  })

  yield* sources.register({
    list: Match.type<VideoQuery>().pipe(
      Match.tag("ImdbSeasonQuery", (query) => {
        if (Option.isNone(query.titleMatcher)) return Stream.empty
        const titleMatcher = query.titleMatcher.value
        return Cache.get(
          search,
          new SearchRequest({ imdbId: query.imdbId }),
        ).pipe(
          Effect.map(Array.filter((_) => titleMatcher(_.name))),
          Stream.fromIterableEffect,
          Stream.flatMap(
            (result) =>
              pipe(
                Cache.get(files, new FilesRequest({ id: result.id })),
                Effect.map(
                  (files): Stream.Stream<SourceSeason | SourceStreamWithFile> =>
                    Array.match(files, {
                      onEmpty: () => Stream.make(result.asSeason),
                      onNonEmpty: (files) =>
                        pipe(
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
                          Stream.fromIterable,
                        ),
                    }),
                ),
                Stream.unwrap,
              ),
            { concurrency: "unbounded" },
          ),
          Stream.orDie,
          Stream.withSpan("Source.Tpb.Imdb season", { attributes: { query } }),
        )
      }),
      Match.tag("ImbdMovieQuery", "ImdbSeriesQuery", (query) =>
        Cache.get(search, new SearchRequest({ imdbId: query.imdbId })).pipe(
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
}).pipe(Layer.effectDiscard, Layer.provide(Sources.layer))

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
