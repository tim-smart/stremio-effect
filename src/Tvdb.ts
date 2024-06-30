import { Config, Context, Effect, flow, Layer, Redacted } from "effect"
import { cacheWithSpan, configProviderNested } from "./Utils.js"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import * as S from "@effect/schema/Schema"
import { Schema } from "@effect/schema"

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

  const lookupEpisode = yield* cacheWithSpan({
    lookup: (id: number) =>
      HttpClientRequest.get(`/episodes/${id}`).pipe(
        clientWithToken,
        Episode.decodeResponse,
        Effect.map(_ => _.data),
        Effect.withSpan("Tvdb.lookupEpisode", { attributes: { id } }),
      ),
    capacity: 1024,
    timeToLive: "12 hours",
  })

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
  aired: S.String,
  runtime: S.Number,
  isMovie: S.Number,
  seasons: S.Array(Season),
  number: S.Number,
  absoluteNumber: S.Number,
  seasonNumber: S.Number,
  lastUpdated: S.String,
  finaleType: S.Union(S.Null, S.String),
  year: S.String,
}) {}

export class Episode extends S.Class<Episode>("Episode")({
  status: S.String,
  data: EpisodeData,
}) {
  static decodeResponse = HttpClientResponse.schemaBodyJsonScoped(this)
}
