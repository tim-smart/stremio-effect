import {
  Array,
  Config,
  ConfigProvider,
  Data,
  Effect,
  flow,
  Layer,
  Redacted,
} from "effect"
import { Sources, SourceStream } from "./Sources.js"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
} from "@effect/platform"
import { Schema } from "@effect/schema"
import { cacheWithSpan, magnetFromHash } from "./Utils.js"
import { StremioRouter } from "./Stremio.js"

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

  const availability = (hashes: ReadonlyArray<string>) =>
    HttpClientRequest.get(
      `/torrents/instantAvailability/${hashes.join("/")}`,
    ).pipe(client, decodeAvailabilityResponse)

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
    transform: (streams, baseUrl) =>
      availability(streams.flatMap(_ => (_.infoHash ? [_.infoHash] : []))).pipe(
        Effect.whenEffect(userIsPremium),
        Effect.flatten,
        Effect.map(availability =>
          streams.map(stream => {
            if (
              stream.infoHash &&
              stream.infoHash.toLowerCase() in availability &&
              availability[stream.infoHash.toLowerCase()].length > 0
            ) {
              const file = Object.keys(
                availability[stream.infoHash.toLowerCase()][0],
              )[0]
              return new SourceStream({
                ...stream,
                url: new URL(
                  `/real-debrid/${stream.infoHash}/${file}`,
                  baseUrl,
                ).toString(),
                source: `${stream.source} [RD]`,
              })
            }
            return stream
          }),
        ),
        Effect.tapErrorCause(Effect.logDebug),
        Effect.orElseSucceed(() => streams),
        Effect.withSpan("RealDebrid.transform"),
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
