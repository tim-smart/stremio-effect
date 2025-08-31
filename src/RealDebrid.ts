import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http"
import { Request } from "effect/batching"
import { Config } from "effect/config"
import { Effect, flow, Layer, pipe, Schedule } from "effect"
import { SourceStream, SourceStreamWithFile } from "./Domain/SourceStream.js"
import { Sources } from "./Sources.js"
import { StremioRouter } from "./Stremio.js"
import { magnetFromHash } from "./Utils.js"
import { Schema } from "effect/schema"
import { Array } from "effect/collections"
import { Cache } from "effect/caching"
import { Option, Order } from "effect/data"

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

  class ResolveRequest extends Request.TaggedClass("ResolveRequest")<
    {
      infoHash: string
      file: string
    },
    typeof UnrestrictLinkResponse.Type
  > {}
  //   "ResolveRequest",
  //   {
  //     failure: Schema.Never,
  //     success: UnrestrictLinkResponse,
  //     payload: {
  //       infoHash: Schema.String,
  //       file: Schema.String,
  //     },
  //   },
  // ) {
  //   [PrimaryKey.symbol]() {
  //     return Hash.hash(this).toString()
  //   }
  // }
  const resolve = yield* Cache.makeWith<
    ResolveRequest,
    { readonly download: string }
  >({
    // storeId: "RealDebrid.resolve",
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
    capacity: 1024,
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
        Cache.get(resolve, new ResolveRequest({ infoHash, file })),
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
}).pipe(
  Effect.annotateLogs({
    service: "RealDebrid",
  }),
  Layer.effectDiscard,
  Layer.provide([Sources.layer, StremioRouter.layer]),
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
