import {
  Config,
  Context,
  Data,
  Effect,
  flow,
  Layer,
  PrimaryKey,
  Redacted,
  Schedule,
} from "effect"
import { configProviderNested } from "./Utils.js"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import * as S from "@effect/schema/Schema"
import { Schema, Serializable } from "@effect/schema"
import { PersistedCache } from "@effect/experimental"

const make = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("apiKey")
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(HttpClientRequest.prependUrl("https://api4.thetvdb.com/v4")),
    ),
    HttpClient.filterStatusOk,
  )

  const apiToken = yield* HttpClientRequest.post("/login").pipe(
    HttpClientRequest.bodyUnsafeJson({
      apikey: Redacted.value(apiKey),
    }),
    client.execute,
    Effect.flatMap(
      HttpClientResponse.schemaBodyJson(
        Schema.Struct({
          data: Schema.Struct({
            token: Schema.Redacted(Schema.String),
          }),
        }),
      ),
    ),
    Effect.scoped,
  )

  const clientWithToken = client.pipe(
    HttpClient.mapRequest(
      HttpClientRequest.bearerToken(Redacted.value(apiToken.data.token)),
    ),
  )

  class LookupEpisode extends Data.Class<{ id: number }> {
    [PrimaryKey.symbol]() {
      return this.id.toString()
    }
    get [Serializable.symbolResult]() {
      return {
        success: EpisodeData,
        failure: Schema.Never,
      }
    }
  }

  const lookupEpisodeCache = yield* PersistedCache.make({
    storeId: "Tvdb.lookupEpisode",
    lookup: ({ id }: LookupEpisode) =>
      clientWithToken.get(`/episodes/${id}`).pipe(
        Effect.flatMap(Episode.decodeResponse),
        Effect.scoped,
        Effect.retry({
          while: err =>
            err._tag === "ResponseError" && err.response.status >= 500,
          times: 5,
          schedule: Schedule.exponential(100),
        }),
        Effect.orDie,
        Effect.map(_ => _.data),
        Effect.withSpan("Tvdb.lookupEpisode", { attributes: { id } }),
      ),
    timeToLive: (_, exit) => (exit._tag === "Success" ? "1 week" : "1 hour"),
    inMemoryCapacity: 16,
  })
  const lookupEpisode = (id: number) =>
    lookupEpisodeCache.get(new LookupEpisode({ id }))

  return { lookupEpisode } as const
}).pipe(Effect.withConfigProvider(configProviderNested("tvdb")))

export class Tvdb extends Context.Tag("Tvdb")<
  Tvdb,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.scoped(Tvdb, make)
}

export class Season extends S.Class<Season>("Season")({
  id: S.Number,
  seriesId: S.Number,
  name: S.optional(S.Union(S.Null, S.String)),
  number: S.Number,
  lastUpdated: S.String,
}) {}

export class EpisodeData extends S.Class<EpisodeData>("Data")({
  id: S.Number,
  seriesId: S.Number,
  name: S.String,
  isMovie: S.Number,
  seasons: S.Array(Season),
  number: S.Number,
  absoluteNumber: S.Number,
  seasonNumber: S.Number,
  year: S.String,
}) {}

export class Episode extends S.Class<Episode>("Episode")({
  status: S.String,
  data: EpisodeData,
}) {
  static decodeResponse = HttpClientResponse.schemaBodyJson(this)
}
