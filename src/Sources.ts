import {
  Array,
  Context,
  Data,
  Effect,
  Equal,
  GroupBy,
  Hash,
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
    Stream.fromIterable(sources).pipe(
      Stream.bindTo("source"),
      Stream.bind("query", () => queriesFromRequest(request)),
      Stream.bind("sourceResult", ({ source, query }) => source.list(query), {
        concurrency: "unbounded",
      }),
      Stream.bind("result", ({ sourceResult }) => {
        if (embellishers.size === 0) {
          return sourceResult._tag === "SourceStream"
            ? Stream.make(sourceResult)
            : Stream.empty
        }
        return Array.reduce(
          embellishers,
          Effect.succeed([sourceResult]),
          (acc, embellisher) =>
            Effect.flatMap(
              acc,
              Effect.forEach(_ => embellisher.transform(_, baseUrl)),
            ).pipe(Effect.map(Array.flatten)),
        ).pipe(Stream.fromIterableEffect) as Stream.Stream<SourceStream>
      }),
      Stream.filter(({ query, result }) =>
        query.titleMatcher._tag === "Some"
          ? query.titleMatcher.value(result.title)
          : true,
      ),
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
  static Live = Layer.effect(Sources, make)
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
  ) => Effect.Effect<ReadonlyArray<SourceStream>>
}
