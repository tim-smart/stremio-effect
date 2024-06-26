import {
  Array,
  Context,
  Data,
  Effect,
  Layer,
  Order,
  pipe,
  Record,
} from "effect"
import * as Stremio from "stremio-addon-sdk"
import { StreamRequest } from "./Stremio.js"
import { bytesToSize, cacheWithSpan } from "./Utils.js"

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

  const listUncached = (request: StreamRequest, baseUrl: string) =>
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
    readonly baseUrl: string
  }> {}
  const listCache = yield* cacheWithSpan({
    lookup: (request: ListRequest) =>
      listUncached(request.request, request.baseUrl),
    capacity: 1024,
    timeToLive: "1 hour",
  })
  const list = (request: StreamRequest, baseUrl: string) =>
    listCache(new ListRequest({ request, baseUrl }))

  return { list, register, registerEmbellisher } as const
})

export class Sources extends Context.Tag("stremio/Sources")<
  Sources,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.effect(Sources, make)
}

// quality order

const qualityPriorities = [
  ["3D", 0],
  ["2160p", 1],
  ["1080p", 2],
  ["720p", 3],
  ["480p", 4],
] as const
const qualityPriority = (quality: string) =>
  qualityPriorities.find(([q]) => quality.startsWith(q))?.[1] ??
  qualityPriorities.length
const qualityOrder = Order.make<string>((a, b) => {
  const aPriority = qualityPriority(a)
  const bPriority = qualityPriority(b)
  return aPriority < bPriority ? -1 : aPriority > bPriority ? 1 : 0
})

// domain

export interface Source {
  readonly list: (
    request: StreamRequest,
  ) => Effect.Effect<ReadonlyArray<SourceStream>>
}

export class SourceStream extends Data.Class<{
  source: string
  infoHash: string
  magnetUri: string
  quality: string
  seeds: number
  peers: number
  sizeBytes?: number
  sizeDisplay?: string
  url?: string
}> {
  static Order = Order.struct({
    quality: qualityOrder,
    seeds: Order.reverse(Order.number),
  })

  static sort = (streams: ReadonlyArray<SourceStream>) =>
    pipe(
      streams,
      Array.groupBy(_ => _.quality),
      Record.map(Array.take(3)),
      Record.values,
      Array.flatten,
      Array.sort(this.Order),
    )

  get sizeFormatted() {
    if (this.sizeBytes) {
      return bytesToSize(this.sizeBytes)
    } else if (this.sizeDisplay) {
      return this.sizeDisplay
    }
    return "0B"
  }

  get asStremio(): Stremio.Stream {
    return {
      url: this.url,
      infoHash: this.infoHash,
      title: `${this.quality}
${this.sizeFormatted}  ⬆️ ${this.seeds}  ⬇️ ${this.peers}`,
      name: this.source,
      behaviorHints: {
        group: `effect-${this.quality}`,
      },
    }
  }
}

export interface Embellisher {
  readonly transform: (
    streams: ReadonlyArray<SourceStream>,
    baseUrl: string,
  ) => Effect.Effect<ReadonlyArray<SourceStream>>
}
