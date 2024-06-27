import { Context, Data, Effect, Equal, Hash, Layer } from "effect"
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
    Effect.forEach(sources, source => source.list(request), {
      concurrency: "unbounded",
    }).pipe(
      Effect.map(sources => SourceStream.sort(sources.flat())),
      Effect.flatMap(streams =>
        streams.length > 0
          ? Effect.reduce(
              embellishers.values(),
              streams as ReadonlyArray<SourceStream>,
              (streams, embellishers) =>
                embellishers.transform(streams, baseUrl),
            )
          : Effect.succeed(streams),
      ),
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
    request: StreamRequest,
  ) => Effect.Effect<ReadonlyArray<SourceStream>>
}

export interface Embellisher {
  readonly transform: (
    streams: ReadonlyArray<SourceStream>,
    baseUrl: URL,
  ) => Effect.Effect<ReadonlyArray<SourceStream>>
}
