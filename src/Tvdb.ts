import {
  Config,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
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
import { PersistedCache, TimeToLive } from "@effect/experimental"

const make = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("apiKey")
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(HttpClientRequest.prependUrl("https://api4.thetvdb.com/v4")),
    ),
    HttpClient.filterStatusOk,
  )

  const apiToken = yield* HttpClientRequest.post("/login").pipe(
    HttpClientRequest.unsafeJsonBody({
      apikey: Redacted.value(apiKey),
    }),
    client,
    HttpClientResponse.schemaBodyJsonScoped(
      Schema.Struct({
        data: Schema.Struct({
          token: Schema.Redacted(Schema.String),
        }),
      }),
    ),
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
    [TimeToLive.symbol](exit: Exit.Exit<unknown, unknown>) {
      return exit._tag === "Success" ? "1 week" : "1 hour"
    }
    get [Serializable.symbolResult]() {
      return {
        Success: EpisodeData,
        Failure: Schema.Never,
      }
    }
  }

  const lookupEpisodeCache = yield* PersistedCache.make({
    storeId: "Tvdb.lookupEpisode",
    lookup: ({ id }: LookupEpisode) =>
      HttpClientRequest.get(`/episodes/${id}`).pipe(
        clientWithToken,
        Effect.retry({
          while: err =>
            err._tag === "ResponseError" && err.response.status >= 500,
          times: 5,
          schedule: Schedule.exponential(100),
        }),
        Episode.decodeResponse,
        Effect.orDie,
        Effect.map(_ => _.data),
        Effect.withSpan("Tvdb.lookupEpisode", { attributes: { id } }),
      ),
  })
  const lookupEpisode = (id: number) =>
    lookupEpisodeCache.get(new LookupEpisode({ id }))

  return { lookupEpisode } as const
}).pipe(Effect.withConfigProvider(configProviderNested("tvdb")))

export class Tvdb extends Context.Tag("Tvdb")<
  Tvdb,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.effect(Tvdb, make)
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
  static decodeResponse = HttpClientResponse.schemaBodyJsonScoped(this)
}
