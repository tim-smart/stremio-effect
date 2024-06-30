import {
  Array,
  Context,
  Data,
  Effect,
  Equal,
  GroupBy,
  Hash,
  Iterable,
  Layer,
  Stream,
} from "effect"
import { StreamRequest } from "./Stremio.js"
import { cacheWithSpan } from "./Utils.js"
import { SourceSeason, SourceStream } from "./Domain/SourceStream.js"
import {
  ChannelQuery,
  ImdbMovieQuery,
  ImdbSeasonQuery,
  ImdbSeriesQuery,
  ImdbTvQuery,
  nonSeasonQuery,
  VideoQuery,
} from "./Domain/VideoQuery.js"
import { Cinemeta } from "./Cinemeta.js"

const make = Effect.gen(function* () {
  const sources = new Set<Source>()
  const embellishers = new Set<Embellisher>()

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
        Stream.merge(
          cinemeta.lookupMovie(imdbId).pipe(
            Effect.map(_ => _.queries),
            Effect.tapErrorCause(Effect.logDebug),
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
        Stream.merge(
          cinemeta.lookupEpisode(imdbId, season, episode).pipe(
            Effect.map(_ => _.queries),
            Effect.tapErrorCause(Effect.logDebug),
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
    queriesFromRequest(request).pipe(
      Stream.bindTo("query"),
      Stream.let("nonSeasonQuery", ({ query }) => nonSeasonQuery(query)),
      Stream.bind("source", () => Stream.fromIterable(sources)),
      Stream.bind("sourceResult", ({ source, query }) => source.list(query), {
        concurrency: "unbounded",
      }),
      Stream.filter(({ sourceResult, query }) => {
        if (sourceResult.verified) {
          return true
        }
        return query.titleMatcher._tag === "Some"
          ? query.titleMatcher.value(sourceResult.title)
          : true
      }),
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
      Stream.filter(({ nonSeasonQuery, result }) => {
        if (result.verified) {
          return true
        }
        return nonSeasonQuery.titleMatcher._tag === "Some"
          ? nonSeasonQuery.titleMatcher.value(result.title)
          : true
      }),
      Stream.map(_ => _.result),
      Stream.groupByKey(_ => _.quality),
      GroupBy.evaluate((_, stream) => Stream.take(stream, 3)),
      Stream.runCollect,
      Effect.map(Array.sort(SourceStream.Order)),
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
  }
  const listCache = yield* cacheWithSpan({
    lookup: (request: ListRequest) =>
      listUncached(request.request, request.baseUrl),
    capacity: 4096,
    timeToLive: "12 hours",
  })
  const list = (request: StreamRequest, baseUrl: URL) =>
    listCache(new ListRequest({ request, baseUrl }))

  return { list, register, registerEmbellisher } as const
})

export class Sources extends Context.Tag("stremio/Sources")<
  Sources,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.effect(Sources, make).pipe(Layer.provide(Cinemeta.Live))
}

// domain

export interface Source {
  readonly list: (
    query: VideoQuery,
  ) => Stream.Stream<SourceStream | SourceSeason>
}

export interface Embellisher {
  readonly transform: (
    stream: SourceStream | SourceSeason,
    baseUrl: URL,
  ) => Stream.Stream<SourceStream>
}
