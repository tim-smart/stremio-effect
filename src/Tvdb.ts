import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { Config, Effect, Layer, Schedule, ServiceMap } from "effect"
import { Schema as S, Schema } from "effect/schema"
import { Redacted } from "effect/data"
import { Persistable, PersistedCache } from "effect/unstable/persistence"
import { PersistenceLayer } from "./Persistence.js"

export class Tvdb extends ServiceMap.Service<Tvdb>()("Tvdb", {
  make: Effect.gen(function* () {
    const apiKey = yield* Config.schema(
      Schema.Redacted(Schema.String),
      "TVDB_API_KEY",
    )
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        HttpClientRequest.prependUrl("https://api4.thetvdb.com/v4"),
      ),
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({
        times: 5,
        schedule: Schedule.exponential(100),
      }),
    )

    const apiToken = yield* HttpClientRequest.post("/login").pipe(
      HttpClientRequest.bodyJsonUnsafe({
        apikey: Redacted.value(apiKey),
      }),
      client.execute,
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(
          Schema.Struct({
            data: Schema.Struct({
              token: Schema.String,
            }),
          }),
        ),
      ),
      Effect.scoped,
    )

    const clientWithToken = client.pipe(
      HttpClient.mapRequest(HttpClientRequest.bearerToken(apiToken.data.token)),
    )

    class TvdbLookup extends Persistable.Class<{
      payload: { id: number }
    }>()("Tvdb.lookupEpisode", {
      primaryKey: (_) => _.id.toString(),
      success: EpisodeData,
    }) {}

    const lookupEpisodeCache = yield* PersistedCache.make({
      storeId: "Tvdb.lookupEpisode",
      lookup: ({ id }: TvdbLookup) =>
        clientWithToken.get(`/episodes/${id}`).pipe(
          Effect.flatMap(Episode.decodeResponse),
          Effect.scoped,
          Effect.orDie,
          Effect.map((_) => _.data),
          Effect.withSpan("Tvdb.lookupEpisode", { attributes: { id } }),
        ),
      timeToLive: (exit) => (exit._tag === "Success" ? "1 week" : "1 hour"),
      inMemoryCapacity: 16,
    })
    const lookupEpisode = (id: number) =>
      lookupEpisodeCache.get(new TvdbLookup({ id }))

    return { lookupEpisode } as const
  }),
}) {
  static layer = Layer.effect(this)(this.make).pipe(
    Layer.provide(PersistenceLayer),
  )
}

export class Season extends S.Class<Season>("Season")({
  id: S.Number,
  seriesId: S.Number,
  number: S.Number,
  lastUpdated: S.String,
}) {}

export class EpisodeData extends S.Class<EpisodeData>("Data")({
  id: S.Number,
  seriesId: S.Number,
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
