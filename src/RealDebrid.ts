import { PersistedCache } from "@effect/experimental"
import { dataLoader, persisted } from "@effect/experimental/RequestResolver"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
} from "@effect/platform"
import { Schema, Serializable } from "@effect/schema"
import {
  Array,
  Config,
  ConfigProvider,
  Effect,
  Equal,
  flow,
  Hash,
  Layer,
  Option,
  pipe,
  PrimaryKey,
  Record,
  Redacted,
  Request,
  RequestResolver,
  Schedule,
  Stream,
  Tracer,
} from "effect"
import { SourceStream } from "./Domain/SourceStream.js"
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
        HttpClientRequest.bearerToken(Redacted.value(apiKey)),
      ),
    ),
    HttpClient.filterStatusOk,
    HttpClient.transformResponse(
      Effect.retry({
        while: err =>
          err._tag === "ResponseError" && err.response.status >= 429,
        times: 5,
        schedule: Schedule.exponential(100),
      }),
    ),
  )
  const user = yield* HttpClientRequest.get("/user").pipe(
    client,
    HttpClientResponse.schemaBodyJsonScoped(
      Schema.Struct({
        type: Schema.Literal("premium", "free"),
      }),
    ),
    Effect.tapErrorCause(Effect.log),
    Effect.cachedWithTTL("1 hour"),
  )
  const userIsPremium = user.pipe(
    Effect.map(_ => _.type === "premium"),
    Effect.orElseSucceed(() => false),
  )

  const addMagnet = (magnet: string) =>
    HttpClientRequest.post("/torrents/addMagnet").pipe(
      HttpClientRequest.urlParamsBody({ magnet }),
      client,
      decodeAddMagnetResponse,
    )

  const getTorrentInfo = (id: string) =>
    HttpClientRequest.get(`/torrents/info/${id}`).pipe(
      client,
      decodeTorrentInfo,
    )

  class AvailabilityRequest extends Request.Class<
    Option.Option<Array<AvailabilityFile>>,
    never,
    {
      infoHash: string
      span: Tracer.Span
    }
  > {
    [PrimaryKey.symbol]() {
      return this.infoHash
    }
    [Equal.symbol](that: AvailabilityRequest) {
      return this.infoHash === that.infoHash
    }
    [Hash.symbol]() {
      return Hash.string(this.infoHash)
    }
    get [Serializable.symbolResult]() {
      return {
        success: AvailabilityFile.OptionArray,
        failure: Schema.Never,
      }
    }
  }
  const AvailabilityResolver = yield* RequestResolver.makeBatched(
    (requests: Array<AvailabilityRequest>) =>
      HttpClientRequest.get(
        `/torrents/instantAvailability/${requests.map(_ => _.infoHash).join("/")}`,
      ).pipe(
        client,
        decodeAvailabilityResponse,
        Effect.flatMap(availability =>
          Effect.forEach(
            requests,
            request => {
              const hash = request.infoHash.toLowerCase()
              if (hash in availability && availability[hash].length > 0) {
                const fileRecord: Record<
                  string,
                  { filename: string; filesize: number }
                > = {}
                for (const files of availability[hash]) {
                  Object.assign(fileRecord, files)
                }
                return Request.succeed(
                  request,
                  pipe(
                    Record.toEntries(fileRecord),
                    Array.map(([fileNumber, { filename, filesize }]) => ({
                      fileNumber,
                      fileName: filename,
                      fileSize: filesize,
                    })),
                    Array.filter(_ => _.fileSize > 10 * 1024 * 1024),
                    Option.liftPredicate(Array.isNonEmptyArray),
                  ),
                )
              }
              return Request.succeed(request, Option.none())
            },
            { discard: true },
          ),
        ),
        Effect.orDie,
        Effect.catchAllCause(cause =>
          Effect.forEach(requests, Request.failCause(cause)),
        ),
        Effect.withSpan("RealDebrid.AvailabilityResolver", {
          attributes: {
            batchSize: requests.length,
          },
          links: requests.map(request => ({
            _tag: "SpanLink",
            span: request.span,
            attributes: {},
          })),
        }),
      ),
  ).pipe(
    persisted({
      storeId: "RealDebrid.Availability",
      timeToLive: (_, exit) =>
        exit._tag === "Success" ? "1 week" : "5 minutes",
    }),
    Effect.flatMap(dataLoader({ window: 200 })),
  )

  const selectFiles = (id: string, files: ReadonlyArray<string>) =>
    HttpClientRequest.post(`/torrents/selectFiles/${id}`).pipe(
      HttpClientRequest.urlParamsBody({ files: files.join(",") }),
      client,
      HttpClientResponse.void,
    )

  const unrestrictLink = (link: string) =>
    HttpClientRequest.post("/unrestrict/link").pipe(
      HttpClientRequest.urlParamsBody({ link }),
      client,
      decodeUnrestrictLinkResponse,
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
      addMagnet(magnetFromHash(request.infoHash)).pipe(
        Effect.tap(_ => selectFiles(_.id, [request.file])),
        Effect.andThen(_ => getTorrentInfo(_.id)),
        Effect.andThen(info => unrestrictLink(info.links[0])),
        Effect.tapErrorCause(Effect.log),
        Effect.orDie,
        Effect.withSpan("RealDebrid.resolve", { attributes: { request } }),
      ),
    timeToLive: (_, exit) => (exit._tag === "Success" ? "1 hour" : "5 minutes"),
    inMemoryCapacity: 4,
  })

  yield* sources.registerEmbellisher({
    transform: (stream, baseUrl) =>
      Effect.makeSpanScoped("RealDebrid.transform", {
        attributes: { infoHash: stream.infoHash },
      }).pipe(
        Effect.flatMap(span =>
          Effect.request(
            new AvailabilityRequest({ infoHash: stream.infoHash, span }),
            AvailabilityResolver,
          ),
        ),
        Effect.withRequestCaching(true),
        Effect.map(
          Option.match({
            onNone: () => [],
            onSome: files => {
              if (stream._tag === "SourceStream") {
                const file = files[0]
                return [
                  new SourceStream({
                    ...stream,
                    sizeBytes: files[0].fileSize,
                    url: new URL(
                      `${baseUrl.pathname}/real-debrid/${stream.infoHash}/${file.fileNumber}`,
                      baseUrl,
                    ).toString(),
                  }),
                ]
              }
              return files.map(
                file =>
                  new SourceStream({
                    ...stream,
                    title: file.fileName,
                    sizeBytes: file.fileSize,
                    quality: stream.quality,
                    url: new URL(
                      `${baseUrl.pathname}/real-debrid/${stream.infoHash}/${file.fileNumber}`,
                      baseUrl,
                    ).toString(),
                  }),
              )
            },
          }),
        ),
        Effect.whenEffect(userIsPremium),
        Effect.flatten,
        Effect.tapErrorCause(Effect.logDebug),
        Effect.orElseSucceed(() =>
          stream._tag === "SourceStream" ? [stream] : [],
        ),
        Effect.annotateLogs({
          service: "RealDebrid",
          method: "transform",
        }),
        Effect.scoped,
        Stream.fromIterableEffect,
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
    Effect.gen(function* () {
      const { hash: infoHash, file } = yield* resolveParams
      const url = yield* resolve.get(new ResolveRequest({ infoHash, file }))
      return HttpServerResponse.empty({ status: 302 }).pipe(
        HttpServerResponse.setHeader("Location", url.download),
      )
    }).pipe(
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
  Layer.provide(Sources.Live),
  Layer.provide(StremioRouter.Live),
)

const AddMagnetResponse = Schema.Struct({
  id: Schema.String,
  uri: Schema.String,
})
const decodeAddMagnetResponse =
  HttpClientResponse.schemaBodyJsonScoped(AddMagnetResponse)

const Files = Schema.Record({
  key: Schema.String,
  value: Schema.Struct({
    filename: Schema.String,
    filesize: Schema.Number,
  }),
})

const AvailabilityResponse = Schema.Record({
  key: Schema.String,
  value: Schema.Union(
    Schema.Record({ key: Schema.String, value: Schema.Array(Files) }),
    Schema.Array(Schema.Unknown),
  ).pipe(
    Schema.transform(Schema.Array(Files), {
      decode: value => {
        if (Array.isArray(value)) {
          return []
        }
        return Object.values(
          value as Record<string, Array<typeof Files.Type>>,
        ).flat()
      },
      encode: value => ({ rd: value }),
    }),
  ),
})
const decodeAvailabilityResponse =
  HttpClientResponse.schemaBodyJsonScoped(AvailabilityResponse)

const TorrentInfo = Schema.Struct({
  links: Schema.NonEmptyArray(Schema.String),
})
const decodeTorrentInfo = HttpClientResponse.schemaBodyJsonScoped(TorrentInfo)

const UnrestrictLinkResponse = Schema.Struct({
  download: Schema.String,
})
const decodeUnrestrictLinkResponse = HttpClientResponse.schemaBodyJsonScoped(
  UnrestrictLinkResponse,
)

class AvailabilityFile extends Schema.Class<AvailabilityFile>(
  "AvailabilityFile",
)({
  fileNumber: Schema.String,
  fileName: Schema.String,
  fileSize: Schema.Number,
}) {
  static OptionArray = Schema.Option(Schema.Array(this))
}
