import { Effect, Layer, pipe, ServiceMap } from "effect"
import { Cinemeta } from "./Cinemeta.js"
import * as QualityGroup from "./Domain/QualityGroup.js"
import {
  SourceSeason,
  SourceStream,
  SourceStreamWithFile,
} from "./Domain/SourceStream.js"
import {
  ChannelQuery,
  ImdbMovieQuery,
  ImdbSeasonQuery,
  ImdbSeriesQuery,
  ImdbTvQuery,
  nonSeasonQuery,
  VideoQuery,
} from "./Domain/VideoQuery.js"
import { StreamRequest, streamRequestId } from "./Stremio.js"
import { TorrentMeta } from "./TorrentMeta.js"
import { Stream } from "effect/stream"
import { Data, Filter, Option } from "effect/data"
import { Equal, Hash, PrimaryKey } from "effect/interfaces"
import { Cache } from "effect/caching"
import { Array, Iterable } from "effect/collections"

export class Sources extends ServiceMap.Key<Sources>()("stremio/Sources", {
  make: Effect.gen(function* () {
    const sources = new Set<Source>()
    const embellishers = new Set<Embellisher>()
    const torrentMeta = yield* TorrentMeta

    const register = (source: Source) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          sources.add(source)
        }),
        () => Effect.sync(() => sources.delete(source)),
      )

    const registerEmbellisher = (embellisher: Embellisher) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          embellishers.add(embellisher)
        }),
        () => Effect.sync(() => embellishers.delete(embellisher)),
      )

    const cinemeta = yield* Cinemeta
    const queriesFromRequest: (
      request: StreamRequest,
    ) => Stream.Stream<VideoQuery> = StreamRequest.$match({
      Channel: ({ id }) => Stream.make(new ChannelQuery({ id })),
      Movie: ({ imdbId }) =>
        Stream.make(new ImdbMovieQuery({ imdbId })).pipe(
          Stream.concat(
            cinemeta.lookupMovie(imdbId).pipe(
              Effect.map((_) => _.queries),
              Effect.tapCause(Effect.logDebug),
              Effect.orElseSucceed(() => []),
              Effect.withSpan("Sources.queriesFromRequest Movie", {
                attributes: { imdbId },
              }),
              Effect.annotateLogs({
                service: "Sources",
                method: "queriesFromRequest",
                kind: "Move",
              }),
              Stream.fromIterableEffect,
            ),
          ),
        ),
      Series: ({ imdbId, season, episode }) =>
        Stream.make(
          new ImdbSeriesQuery({ imdbId, season, episode }),
          new ImdbSeasonQuery({ imdbId, season, episode }),
        ).pipe(
          Stream.concat(
            cinemeta.lookupEpisode(imdbId, season, episode).pipe(
              Effect.map((_) => _.flatMap((_) => _.queries)),
              Effect.tapCause(Effect.logDebug),
              Effect.orElseSucceed(() => []),
              Effect.withSpan("Sources.queriesFromRequest Series", {
                attributes: { imdbId, season, episode },
              }),
              Effect.annotateLogs({
                service: "Sources",
                method: "queriesFromRequest",
                kind: "Series",
              }),
              Stream.fromIterableEffect,
            ),
          ),
        ),
      Tv: ({ imdbId }) => Stream.make(new ImdbTvQuery({ imdbId })),
    })

    const listUncached = (request: StreamRequest, baseUrl: URL) =>
      // map request to queries
      queriesFromRequest(request).pipe(
        Stream.bindTo("query"),
        Stream.let("nonSeasonQuery", ({ query }) => nonSeasonQuery(query)),
        // for each soucre run the queries
        Stream.bind("source", () => Stream.fromIterable(sources)),
        Stream.bind(
          "sourceResult",
          ({ source, query }) =>
            pipe(
              source.list(query),
              Stream.flatMap(
                (result): Stream.Stream<SourceStream | SourceStreamWithFile> =>
                  result._tag === "SourceStream"
                    ? Stream.make(result)
                    : streamsFromSeason(result),
                { concurrency: "unbounded" },
              ),
            ),
          { concurrency: "unbounded" },
        ),
        // filter out non matches
        Stream.filter(
          Filter.fromPredicate(({ sourceResult, nonSeasonQuery }) => {
            if (
              sourceResult.quality === "480p" ||
              sourceResult.quality === "N/A"
            ) {
              return false
            } else if (sourceResult.verified) {
              return true
            }
            return nonSeasonQuery.titleMatcher._tag === "Some"
              ? nonSeasonQuery.titleMatcher.value(sourceResult.title)
              : true
          }),
        ),
        // embellish the results
        embellishers.size === 0
          ? Stream.bind("result", ({ sourceResult }) =>
              sourceResult._tag === "SourceStream"
                ? Stream.make(sourceResult)
                : Stream.empty,
            )
          : Stream.bind(
              "result",
              ({ sourceResult }) =>
                Iterable.unsafeHead(embellishers).transform(
                  sourceResult,
                  baseUrl,
                ),
              { concurrency: "unbounded" },
            ),
        // filter out non matches
        Stream.filter(
          Filter.fromPredicate(({ nonSeasonQuery, result }) => {
            if (result.verified) {
              return true
            }
            return nonSeasonQuery.titleMatcher._tag === "Some"
              ? nonSeasonQuery.titleMatcher.value(result.title)
              : true
          }),
        ),
        // only keep unique results
        Stream.chunks,
        Stream.mapAccum(new Set<string>(), (hashes, chunk) => {
          const filtered = chunk.filter(({ result }) => {
            const hash = result.infoHash.toLowerCase()
            if (hashes.has(hash)) {
              return false
            }
            hashes.add(hash)
            return true
          })
          return [hashes, filtered]
        }),
        // group by quality and return
        Stream.map((_) => _.result),
        Stream.scan(QualityGroup.empty(), QualityGroup.unsafeAdd),
        Stream.takeUntil(QualityGroup.hasEnough),
        Stream.runLast,
        Effect.map(
          Option.match({
            onNone: () => Array.empty<SourceStream>(),
            onSome: (acc) => Object.values(acc).flat(),
          }),
        ),
        Effect.map(Array.sort(SourceStream.Order)),
      )

    const streamsFromSeason = (season: SourceSeason) =>
      pipe(
        torrentMeta.fromMagnet(season.magnetUri),
        Effect.map((result) => Stream.fromArray(result.streams(season))),
        Effect.withSpan("Sources.streamsFromSeason", {
          attributes: { title: season.title, infoHash: season.infoHash },
        }),
        Effect.catchCause(() => Effect.succeed(Stream.empty)),
        Stream.unwrap,
      )

    class ListRequest extends Data.Class<{
      readonly request: StreamRequest
      readonly baseUrl: URL
    }> {
      [Equal.symbol](that: ListRequest): boolean {
        return Equal.equals(this.request, that.request)
      }
      [Hash.symbol]() {
        return Hash.hash(this.request)
      }
      [PrimaryKey.symbol]() {
        return streamRequestId(this.request)
      }
      // get [Schema.symbolWithResult]() {
      //   return {
      //     success: SourceStream.Array,
      //     failure: Schema.String,
      //   }
      // }
    }
    const listCache = yield* Cache.makeWith({
      // storeId: "Sources.listCache",
      lookup: (request: ListRequest) =>
        listUncached(request.request, request.baseUrl),
      timeToLive: (exit) => {
        if (exit._tag === "Failure") return "1 minute"
        return exit.value.length > 5 ? "3 days" : "6 hours"
      },
      capacity: 1024,
    })
    const list = (request: StreamRequest, baseUrl: URL) =>
      Cache.get(listCache, new ListRequest({ request, baseUrl }))

    return { list, register, registerEmbellisher } as const
  }),
}) {
  static layer = Layer.effect(this)(this.make).pipe(
    Layer.provide([TorrentMeta.layer, Cinemeta.layer]),
  )
}

// domain

export interface Source {
  readonly name: string
  readonly list: (
    query: VideoQuery,
  ) => Stream.Stream<SourceStream | SourceStreamWithFile | SourceSeason>
}

export interface Embellisher {
  readonly transform: (
    stream: SourceStream | SourceStreamWithFile,
    baseUrl: URL,
  ) => Stream.Stream<SourceStream | SourceStreamWithFile>
}
