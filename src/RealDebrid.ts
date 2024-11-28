import { PersistedCache } from "@effect/experimental"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
} from "@effect/platform"
import {
  Array,
  Config,
  ConfigProvider,
  Effect,
  flow,
  Hash,
  Layer,
  Option,
  Order,
  pipe,
  PrimaryKey,
  Schedule,
  Schema,
} from "effect"
import { SourceStream, SourceStreamWithFile } from "./Domain/SourceStream.js"
import { PersistenceLive } from "./Persistence.js"
import { Sources } from "./Sources.js"
import { StremioRouter } from "./Stremio.js"
import { magnetFromHash } from "./Utils.js"

export const RealDebridLive = Effect.gen(function* () {
  const sources = yield* Sources
  const apiKey = yield* Config.redacted("apiKey")

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
  )

  const user = yield* client.get("/user").pipe(
    Effect.flatMap(
      HttpClientResponse.schemaBodyJson(
        Schema.Struct({
          type: Schema.Literal("premium", "free"),
        }),
      ),
    ),
    Effect.scoped,
    Effect.tapErrorCause(Effect.log),
    Effect.cachedWithTTL("1 hour"),
  )
  const userIsPremium = user.pipe(
    Effect.map(_ => _.type === "premium"),
    Effect.orElseSucceed(() => false),
  )

  const addMagnet = (hash: string) =>
    pipe(
      HttpClientRequest.post("/torrents/addMagnet"),
      HttpClientRequest.bodyUrlParams({ magnet: magnetFromHash(hash) }),
      client.execute,
      Effect.flatMap(decodeAddMagnetResponse),
      Effect.scoped,
    )

  const getTorrentInfo = (id: string) =>
    client.get(`/torrents/info/${id}`).pipe(
      Effect.flatMap(decodeTorrentInfo),
      Effect.scoped,
      Effect.tapErrorCause(Effect.log),
      Effect.retry({
        while: err => err._tag === "ParseError",
        schedule: Schedule.spaced(3000).pipe(Schedule.upTo("5 minutes")),
      }),
    )

  const selectFiles = (id: string, files: ReadonlyArray<string>) =>
    HttpClientRequest.post(`/torrents/selectFiles/${id}`).pipe(
      HttpClientRequest.bodyUrlParams({ files: files.join(",") }),
      client.execute,
      Effect.scoped,
    )

  const selectLargestFile = (id: string) =>
    Effect.gen(function* () {
      const info = yield* getTorrentInfo(id)
      const largestFile = Array.max(info.files, FileSizeOrder)
      yield* selectFiles(id, [String(largestFile.id)])
    })

  const unrestrictLink = (link: string) =>
    HttpClientRequest.post("/unrestrict/link").pipe(
      HttpClientRequest.bodyUrlParams({ link }),
      client.execute,
      Effect.flatMap(decodeUnrestrictLinkResponse),
      Effect.scoped,
    )

  class ResolveRequest extends Schema.TaggedRequest<ResolveRequest>()(
    "ResolveRequest",
    {
      failure: Schema.Never,
      success: UnrestrictLinkResponse,
      payload: {
        infoHash: Schema.String,
        file: Schema.String,
      },
    },
  ) {
    [PrimaryKey.symbol]() {
      return Hash.hash(this).toString()
    }
  }
  const resolve = yield* PersistedCache.make({
    storeId: "RealDebrid.resolve",
    lookup: (request: ResolveRequest) =>
      Effect.gen(function* () {
        const torrent = yield* addMagnet(request.infoHash)
        if (request.file === "-1") {
          yield* selectLargestFile(torrent.id)
        } else {
          yield* selectFiles(torrent.id, [request.file])
        }
        const info = yield* getTorrentInfo(torrent.id)
        const link = yield* Effect.fromNullable(info.links[0])
        return yield* unrestrictLink(link)
      }).pipe(
        Effect.tapErrorCause(Effect.log),
        Effect.orDie,
        Effect.withSpan("RealDebrid.resolve", { attributes: { request } }),
      ),
    timeToLive: (_, exit) => (exit._tag === "Success" ? "1 hour" : "5 minutes"),
    inMemoryCapacity: 4,
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
        Effect.whenEffect(userIsPremium),
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
  yield* router.get(
    "/real-debrid/:hash/:file",
    resolveParams.pipe(
      Effect.flatMap(({ hash: infoHash, file }) =>
        resolve.get(new ResolveRequest({ infoHash, file })),
      ),
      Effect.map(url =>
        HttpServerResponse.empty({ status: 302 }).pipe(
          HttpServerResponse.setHeader("Location", url.download),
        ),
      ),
      Effect.catchTag("ParseError", () =>
        HttpServerResponse.empty({ status: 404 }),
      ),
      Effect.annotateLogs({
        service: "RealDebrid",
        method: "http",
      }),
    ),
  )
}).pipe(
  Effect.withConfigProvider(
    ConfigProvider.fromEnv().pipe(
      ConfigProvider.nested("realDebrid"),
      ConfigProvider.constantCase,
    ),
  ),
  Effect.annotateLogs({
    service: "RealDebrid",
  }),
  Layer.scopedDiscard,
  Layer.provide([Sources.Default, StremioRouter.Live, PersistenceLive]),
)

const AddMagnetResponse = Schema.Struct({
  id: Schema.String,
  uri: Schema.String,
})
const decodeAddMagnetResponse =
  HttpClientResponse.schemaBodyJson(AddMagnetResponse)

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
