import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http"
import {
  Config,
  DateTime,
  Effect,
  flow,
  identity,
  Layer,
  pipe,
  Schedule,
} from "effect"
import { SourceStream, SourceStreamWithFile } from "./Domain/SourceStream.js"
import { Sources } from "./Sources.js"
import { StremioRouter } from "./Stremio.js"
import { magnetFromHash } from "./Utils.js"
import { Array } from "effect/collections"
import { Filter, Option, Order } from "effect/data"
import { Schema } from "effect/schema"
import { Persistable, PersistedCache } from "effect/unstable/persistence"
import { PersistenceLayer } from "./Persistence.js"
import { Stream } from "effect/stream"

export const RealDebridLayer = Effect.gen(function* () {
  const sources = yield* Sources
  const apiKey = yield* Config.schema(
    Schema.Redacted(Schema.String),
    "REAL_DEBRID_API_KEY",
  )

  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(
        HttpClientRequest.prependUrl("https://api.real-debrid.com/rest/1.0"),
        HttpClientRequest.bearerToken(apiKey),
      ),
    ),
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({
      times: 5,
      schedule: Schedule.exponential(100),
    }),
    HttpClient.transformResponse(
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    ),
  )

  const user = yield* client.get("/user").pipe(
    Effect.flatMap(
      HttpClientResponse.schemaBodyJson(
        Schema.Struct({
          type: Schema.Literals(["premium", "free"]),
        }),
      ),
    ),
    Effect.tapCause(Effect.log),
    Effect.cachedWithTTL("1 hour"),
  )
  const userIsPremium = user.pipe(
    Effect.map((_) => _.type === "premium"),
    Effect.orElseSucceed(() => false),
  )

  const addMagnet = (hash: string) =>
    pipe(
      HttpClientRequest.post("/torrents/addMagnet"),
      HttpClientRequest.bodyUrlParams({ magnet: magnetFromHash(hash) }),
      client.execute,
      Effect.flatMap(decodeAddMagnetResponse),
    )

  const getTorrentInfo = (id: string) =>
    client.get(`/torrents/info/${id}`).pipe(
      Effect.flatMap(decodeTorrentInfo),
      Effect.tapCause(Effect.log),
      Effect.retry({
        while: (err) => err._tag === "SchemaError",
        schedule: Schedule.spaced(3000).pipe(
          Schedule.both(Schedule.during("5 minutes")),
        ),
      }),
    )

  const listTorrentsReq = HttpClientRequest.get("/torrents", {
    urlParams: { limit: 100 },
  })
  const listTorrentsOffset = (offset: number) =>
    listTorrentsReq.pipe(
      offset === 0
        ? identity
        : HttpClientRequest.setUrlParam("offset", String(offset)),
      client.execute,
      Effect.flatMap(HttpClientResponse.schemaJson(TorrentListItem.Response)),
    )

  const listTorrents = Stream.paginate(0, (offset) =>
    listTorrentsOffset(offset).pipe(
      Effect.map(({ body, headers }) => {
        const nextOffset = offset + body.length
        return [
          body,
          nextOffset < headers["x-total-count"]
            ? Option.some(nextOffset)
            : Option.none<number>(),
        ]
      }),
    ),
  )

  const removeTorrent = (id: string) =>
    HttpClientRequest.del(`/torrents/delete/${id}`).pipe(
      client.execute,
      Effect.asVoid,
    )

  const selectFiles = (id: string, files: ReadonlyArray<string>) =>
    HttpClientRequest.post(`/torrents/selectFiles/${id}`).pipe(
      HttpClientRequest.bodyUrlParams({ files: files.join(",") }),
      client.execute,
    )

  const selectLargestFile = Effect.fnUntraced(function* (id: string) {
    const info = yield* getTorrentInfo(id)
    const largestFile = Array.max(info.files, FileSizeOrder)
    yield* selectFiles(id, [String(largestFile.id)])
  })

  const unrestrictLink = (link: string) =>
    HttpClientRequest.post("/unrestrict/link").pipe(
      HttpClientRequest.bodyUrlParams({ link }),
      client.execute,
      Effect.flatMap(decodeUnrestrictLinkResponse),
    )

  class ResolveRequest extends Persistable.Class<{
    payload: { infoHash: string; file: string }
  }>()("ResolveRequest", {
    primaryKey: (self) => `${self.infoHash}-${self.file}`,
    success: UnrestrictLinkResponse,
  }) {}

  const resolve = yield* PersistedCache.make<ResolveRequest, never>({
    storeId: "RealDebrid.resolve",
    lookup: Effect.fnUntraced(
      function* (request) {
        const torrent = yield* addMagnet(request.infoHash)
        if (request.file === "-1") {
          yield* selectLargestFile(torrent.id)
        } else {
          yield* selectFiles(torrent.id, [request.file])
        }
        const info = yield* getTorrentInfo(torrent.id)
        const link = yield* Effect.fromNullishOr(info.links[0])
        return yield* unrestrictLink(link)
      },
      Effect.tapCause(Effect.log),
      Effect.orDie,
      (effect, request) =>
        Effect.withSpan(effect, "RealDebrid.resolve", {
          attributes: { request },
        }),
    ),
    timeToLive: (exit) => (exit._tag === "Success" ? "1 hour" : "5 minutes"),
    inMemoryCapacity: 16,
  })

  yield* sources.registerEmbellisher({
    transform: (stream, baseUrl) =>
      Effect.succeed(
        "fileNumber" in stream
          ? new SourceStreamWithFile({
              ...stream,
              url: new URL(
                `${baseUrl.pathname}/real-debrid/${stream.infoHash}/${stream.fileNumber + 1}`,
                baseUrl,
              ).toString(),
            })
          : new SourceStream({
              ...stream,
              url: new URL(
                `${baseUrl.pathname}/real-debrid/${stream.infoHash}/-1`,
                baseUrl,
              ).toString(),
            }),
      ).pipe(
        Effect.when(userIsPremium),
        Effect.map(Option.getOrElse(() => stream)),
        Effect.withSpan("RealDebrid.transform", {
          attributes: { infoHash: stream.infoHash },
        }),
      ),
  })

  const router = yield* StremioRouter
  const resolveParams = HttpRouter.schemaPathParams(
    Schema.Struct({
      hash: Schema.String,
      file: Schema.String,
    }),
  )
  yield* router.add(
    "GET",
    "/real-debrid/:hash/:file",
    resolveParams.pipe(
      Effect.flatMap(({ hash: infoHash, file }) =>
        resolve.get(new ResolveRequest({ infoHash, file })),
      ),
      Effect.map((url) =>
        HttpServerResponse.empty({ status: 302 }).pipe(
          HttpServerResponse.setHeader("Location", url.download),
        ),
      ),
      Effect.catchTag("SchemaError", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      ),
      Effect.annotateLogs({
        service: "RealDebrid",
        method: "http",
      }),
    ),
  )

  // Clean up old torrents periodically
  yield* Effect.gen(function* () {
    const now = yield* DateTime.now
    const yesterday = DateTime.subtract(now, { days: 1 })

    yield* listTorrents.pipe(
      Stream.filter(
        Filter.fromPredicate((t) => DateTime.lessThan(t.added, yesterday)),
      ),
      Stream.collect,
      Stream.flattenIterable,
      Stream.tap((t) => removeTorrent(t.id), { concurrency: 5 }),
      Stream.runDrain,
    )
  }).pipe(
    Effect.catchCause(Effect.logWarning),
    Effect.repeat(Schedule.spaced("6 hours")),
    Effect.fork,
  )
}).pipe(
  Effect.annotateLogs({
    service: "RealDebrid",
  }),
  Layer.effectDiscard,
  Layer.provide([Sources.layer, StremioRouter.layer, PersistenceLayer]),
)

const AddMagnetResponse = Schema.Struct({
  id: Schema.String,
  uri: Schema.String,
})
const decodeAddMagnetResponse =
  HttpClientResponse.schemaBodyJson(AddMagnetResponse)

class TorrentListItem extends Schema.Class<TorrentListItem>("TorrentListItem")({
  id: Schema.String,
  added: Schema.DateTimeUtcFromString,
}) {
  static Array = Schema.Array(TorrentListItem)
  static Response = Schema.Struct({
    headers: Schema.Struct({
      "x-total-count": Schema.FiniteFromString,
    }),
    body: TorrentListItem.Array,
  })
}

class TorrentInfo extends Schema.Class<TorrentInfo>("TorrentInfo")({
  links: Schema.Array(Schema.String),
  files: Schema.NonEmptyArray(
    Schema.Struct({
      id: Schema.Number,
      path: Schema.String,
      bytes: Schema.Number,
      selected: Schema.Number,
    }),
  ),
}) {}
const decodeTorrentInfo = HttpClientResponse.schemaBodyJson(TorrentInfo)

const UnrestrictLinkResponse = Schema.Struct({
  download: Schema.String,
})
const decodeUnrestrictLinkResponse = HttpClientResponse.schemaBodyJson(
  UnrestrictLinkResponse,
)

const FileSizeOrder = Order.struct({
  bytes: Order.number,
})
