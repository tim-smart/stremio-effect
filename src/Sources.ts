import {
  Chunk,
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
import { SourceStream } from "./Domain/SourceStream.js"

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

  const listUncached = (request: StreamRequest, baseUrl: URL) =>
    Stream.fromIterable(sources).pipe(
      Stream.flatMap(source => source.list(request), {
        concurrency: sources.size,
      }),
      Stream.groupByKey(_ => _.quality),
      GroupBy.evaluate((_, stream) => Stream.take(stream, 3)),
      Stream.mapEffect(
        stream =>
          Effect.reduce(
            embellishers.values(),
            stream,
            (streams, embellishers) => embellishers.transform(streams, baseUrl),
          ),
        { concurrency: "unbounded" },
      ),
      Stream.runCollect,
      Effect.map(chunk => SourceStream.sort(Chunk.toReadonlyArray(chunk))),
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
  readonly list: (request: StreamRequest) => Stream.Stream<SourceStream>
}

export interface Embellisher {
  readonly transform: (
    stream: SourceStream,
    baseUrl: URL,
  ) => Effect.Effect<SourceStream>
}
