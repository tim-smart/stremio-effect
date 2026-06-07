import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http"
import {
  Array,
  Config,
  DateTime,
  Effect,
  flow,
  Layer,
  Option,
  pipe,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { SourceStream, SourceStreamWithFile } from "./Domain/SourceStream.ts"
import { Sources } from "./Sources.ts"
import { StremioRouter } from "./Stremio.ts"
import { magnetFromHash } from "./Utils.ts"
import { Persistable, PersistedCache } from "effect/unstable/persistence"
import { PersistenceLayer } from "./Persistence.ts"

export const AllDebridLayer = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("ALL_DEBRID_API_KEY").pipe(
    Config.withDefault(undefined),
  )
  if (!apiKey) return

  const sources = yield* Sources

  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(
        HttpClientRequest.prependUrl("https://api.alldebrid.com"),
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

  const user = yield* client.get("/v4/user").pipe(
    Effect.flatMap(decodeUserResponse),
    Effect.map((_) => _.data.user),
    Effect.tapCause(Effect.log),
    Effect.cachedWithTTL("1 hour"),
  )
  const userIsPremium = user.pipe(
    Effect.map((_) => _.isPremium),
    Effect.orElseSucceed(() => false),
  )

  const addMagnet = (hash: string) =>
    pipe(
      HttpClientRequest.post("/v4/magnet/upload"),
      HttpClientRequest.bodyUrlParams({ "magnets[]": magnetFromHash(hash) }),
      client.execute,
      Effect.flatMap(decodeUploadMagnetResponse),
      Effect.map((_) => Array.headNonEmpty(_.data.magnets)),
    )

  const getMagnetFiles = (id: string) =>
    pipe(
      HttpClientRequest.post("/v4/magnet/files"),
      HttpClientRequest.bodyUrlParams({ "id[]": id }),
      client.execute,
      Effect.flatMap(decodeMagnetFilesResponse),
      Effect.map((_) => Array.headNonEmpty(_.data.magnets)),
      Effect.tapCause(Effect.log),
      Effect.retry({
        while: (err) => err._tag === "SchemaError",
        schedule: Schedule.spaced(3000).pipe(
          Schedule.both(Schedule.during("5 minutes")),
        ),
      }),
    )

  const listMagnets = HttpClientRequest.post("/v4.1/magnet/status").pipe(
    client.execute,
    Effect.flatMap(decodeMagnetStatusResponse),
    Effect.map((_) => _.data.magnets),
  )

  const removeMagnet = (id: string) =>
    HttpClientRequest.post("/v4/magnet/delete").pipe(
      HttpClientRequest.bodyUrlParams({ id }),
      client.execute,
      Effect.asVoid,
    )

  const unlockLink = (link: string) =>
    HttpClientRequest.post("/v4/link/unlock").pipe(
      HttpClientRequest.bodyUrlParams({ link }),
      client.execute,
      Effect.flatMap(decodeUnlockLinkResponse),
      Effect.map((_) => _.data),
    )

  class ResolveRequest extends Persistable.Class<{
    payload: { infoHash: string; file: string }
  }>()("AllDebrid.ResolveRequest", {
    primaryKey: (self) => `${self.infoHash}-${self.file}`,
    success: UnlockLinkResponse,
  }) {}

  const resolve = yield* PersistedCache.make(
    Effect.fnUntraced(
      function* (request: ResolveRequest) {
        const torrent = yield* addMagnet(request.infoHash)
        const info = yield* getMagnetFiles(String(torrent.id))
        const files = flattenAllDebridFiles(info.files)
        const file =
          request.file === "-1"
            ? largestFile(files)
            : files[Number.parseInt(request.file, 10) - 1]
        const link = yield* Effect.fromNullishOr(file?.link)
        return yield* unlockLink(link)
      },
      Effect.tapCause(Effect.log),
      Effect.orDie,
      (effect, request) =>
        Effect.withSpan(effect, "AllDebrid.resolve", {
          attributes: { request },
        }),
    ),
    {
      storeId: "AllDebrid.resolve",
      timeToLive: (exit) => (exit._tag === "Success" ? "1 hour" : "5 minutes"),
      inMemoryCapacity: 16,
    },
  )

  yield* sources.registerEmbellisher({
    transform: (stream, baseUrl) =>
      Effect.succeed(
        "fileNumber" in stream
          ? new SourceStreamWithFile({
              ...stream,
              url: new URL(
                `${baseUrl.pathname}/all-debrid/${stream.infoHash}/${stream.fileNumber + 1}`,
                baseUrl,
              ).toString(),
            })
          : new SourceStream({
              ...stream,
              url: new URL(
                `${baseUrl.pathname}/all-debrid/${stream.infoHash}/-1`,
                baseUrl,
              ).toString(),
            }),
      ).pipe(
        Effect.when(userIsPremium),
        Effect.map(Option.getOrElse(() => stream)),
        Effect.withSpan("AllDebrid.transform", {
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
    "/all-debrid/:hash/:file",
    resolveParams.pipe(
      Effect.flatMap(({ hash: infoHash, file }) =>
        resolve.get(new ResolveRequest({ infoHash, file })),
      ),
      Effect.map((url) =>
        HttpServerResponse.empty({ status: 302 }).pipe(
          HttpServerResponse.setHeader("Location", url.link),
        ),
      ),
      Effect.catchTag("SchemaError", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      ),
      Effect.annotateLogs({
        service: "AllDebrid",
        method: "http",
      }),
    ),
  )

  // Clean up old magnets periodically
  yield* Effect.gen(function* () {
    const now = yield* DateTime.now
    const yesterday = DateTime.subtract(now, { days: 1 })
    const magnets = yield* listMagnets

    yield* Stream.fromIterable(magnets).pipe(
      Stream.filter((magnet) =>
        DateTime.isLessThan(
          DateTime.makeUnsafe(magnet.uploadDate * 1000),
          yesterday,
        ),
      ),
      Stream.tap((magnet) => removeMagnet(String(magnet.id)), {
        concurrency: 5,
      }),
      Stream.runDrain,
    )
  }).pipe(
    Effect.catchCause(Effect.logWarning),
    Effect.repeat(Schedule.spaced("6 hours")),
    Effect.forkChild,
  )
}).pipe(
  Effect.annotateLogs({
    service: "AllDebrid",
  }),
  Layer.effectDiscard,
  Layer.provide([Sources.layer, StremioRouter.layer, PersistenceLayer]),
)

const UserResponse = Schema.Struct({
  status: Schema.Literal("success"),
  data: Schema.Struct({
    user: Schema.Struct({
      isPremium: Schema.Boolean,
    }),
  }),
})
const decodeUserResponse = HttpClientResponse.schemaBodyJson(UserResponse)

const UploadMagnetResponse = Schema.Struct({
  status: Schema.Literal("success"),
  data: Schema.Struct({
    magnets: Schema.NonEmptyArray(
      Schema.Struct({
        id: Schema.Number,
        magnet: Schema.String,
        hash: Schema.String,
        name: Schema.String,
        size: Schema.Number,
        ready: Schema.Boolean,
      }),
    ),
  }),
})
const decodeUploadMagnetResponse =
  HttpClientResponse.schemaBodyJson(UploadMagnetResponse)

const AllDebridId = Schema.Union([Schema.String, Schema.Number])

const MagnetFilesResponse = Schema.Struct({
  status: Schema.Literal("success"),
  data: Schema.Struct({
    magnets: Schema.NonEmptyArray(
      Schema.Struct({
        id: AllDebridId,
        files: Schema.NonEmptyArray(Schema.Any),
      }),
    ),
  }),
})
const decodeMagnetFilesResponse =
  HttpClientResponse.schemaBodyJson(MagnetFilesResponse)

class MagnetStatus extends Schema.Class<MagnetStatus>("AllDebrid.MagnetStatus")(
  {
    id: Schema.Number,
    filename: Schema.String,
    size: Schema.Number,
    status: Schema.String,
    statusCode: Schema.Number,
    uploadDate: Schema.Number,
    completionDate: Schema.Number,
  },
) {}
const MagnetStatusResponse = Schema.Struct({
  status: Schema.Literal("success"),
  data: Schema.Struct({
    magnets: Schema.Array(MagnetStatus),
  }),
})
const decodeMagnetStatusResponse =
  HttpClientResponse.schemaBodyJson(MagnetStatusResponse)

const UnlockLinkResponse = Schema.Struct({
  link: Schema.String,
})
const UnlockLinkApiResponse = Schema.Struct({
  status: Schema.Literal("success"),
  data: UnlockLinkResponse,
})
const decodeUnlockLinkResponse = HttpClientResponse.schemaBodyJson(
  UnlockLinkApiResponse,
)

interface AllDebridFile {
  readonly name: string
  readonly bytes: number
  readonly link: string
}

const flattenAllDebridFiles = (
  nodes: ReadonlyArray<unknown>,
): ReadonlyArray<AllDebridFile> =>
  nodes.flatMap((node): ReadonlyArray<AllDebridFile> => {
    if (!isRecord(node)) {
      return []
    }
    if (
      typeof node.n === "string" &&
      typeof node.s === "number" &&
      typeof node.l === "string"
    ) {
      return [{ name: node.n, bytes: node.s, link: node.l }]
    }
    if (globalThis.Array.isArray(node.e)) {
      return flattenAllDebridFiles(node.e)
    }
    return []
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const largestFile = (files: ReadonlyArray<AllDebridFile>) =>
  files.reduce<AllDebridFile | undefined>(
    (largest, file) =>
      largest === undefined || file.bytes > largest.bytes ? file : largest,
    undefined,
  )
