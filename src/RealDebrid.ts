import {
  Array,
  Config,
  ConfigProvider,
  Data,
  Effect,
  flow,
  Layer,
  Option,
  Redacted,
  Request,
  RequestResolver,
} from "effect"
import { Sources } from "./Sources.js"
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
} from "@effect/platform"
import { ParseResult, Schema } from "@effect/schema"
import { cacheWithSpan, magnetFromHash, qualityFromTitle } from "./Utils.js"
import { StremioRouter } from "./Stremio.js"
import { SourceStream } from "./Domain/SourceStream.js"
import { dataLoader } from "@effect/experimental/RequestResolver"

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
    Option.Option<
      Array<{
        readonly fileNumber: string
        readonly fileName: string
        readonly fileSize: number
      }>
    >,
    HttpClientError.HttpClientError | ParseResult.ParseError,
    { infoHash: string }
  > {}
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
                const files = Object.entries(availability[hash][0]).map(
                  ([fileNumber, { filename, filesize }]) => ({
                    fileNumber,
                    fileName: filename,
                    fileSize: filesize,
                  }),
                )
                return Request.succeed(request, Option.some(files))
              }
              return Request.succeed(request, Option.none())
            },
            { discard: true },
          ),
        ),
        Effect.catchAllCause(cause =>
          Effect.forEach(requests, Request.failCause(cause)),
        ),
      ),
  ).pipe(dataLoader({ window: 150 }))

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

  class ResolveRequest extends Data.Class<{
    infoHash: string
    file: string
  }> {}
  const resolve = yield* cacheWithSpan({
    capacity: 1024,
    timeToLive: "1 hour",
    lookup: (request: ResolveRequest) =>
      addMagnet(magnetFromHash(request.infoHash)).pipe(
        Effect.tap(_ => selectFiles(_.id, [request.file])),
        Effect.andThen(_ => getTorrentInfo(_.id)),
        Effect.andThen(info => unrestrictLink(info.links[0])),
      ),
  })

  yield* sources.registerEmbellisher({
    transform: (stream, baseUrl) =>
      Effect.request(
        new AvailabilityRequest({ infoHash: stream.infoHash }),
        AvailabilityResolver,
      ).pipe(
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
              return files
                .filter(file => file.fileSize > 10 * 1024 * 1024)
                .map(
                  file =>
                    new SourceStream({
                      ...stream,
                      title: file.fileName,
                      sizeBytes: file.fileSize,
                      quality: qualityFromTitle(file.fileName),
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
        Effect.withSpan("RealDebrid.transform", {
          attributes: { infoHash: stream.infoHash },
        }),
        Effect.annotateLogs({
          service: "RealDebrid",
          method: "transform",
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
    Effect.gen(function* () {
      const { hash: infoHash, file } = yield* resolveParams
      const url = yield* resolve(new ResolveRequest({ infoHash, file }))
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

const Files = Schema.Record(
  Schema.String,
  Schema.Struct({
    filename: Schema.String,
    filesize: Schema.Number,
  }),
)

const AvailabilityResponse = Schema.Record(
  Schema.String,
  Schema.Union(
    Schema.Record(Schema.String, Schema.Array(Files)),
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
)
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
