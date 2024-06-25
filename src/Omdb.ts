import { Config, Context, Effect, flow, Layer, Redacted } from "effect"
import { cacheWithSpan, configProviderNested } from "./Utils.js"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import * as S from "@effect/schema/Schema"

const make = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("apiKey")
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(HttpClientRequest.prependUrl("http://www.omdbapi.com/")),
    ),
    HttpClient.filterStatusOk,
  )

  const fromImdb = yield* cacheWithSpan({
    lookup: (imdbID: string) =>
      HttpClientRequest.get("/").pipe(
        HttpClientRequest.setUrlParams({
          i: imdbID,
          apiKey: Redacted.value(apiKey),
        }),
        client,
        Movie.decodeResponse,
        Effect.withSpan("Ombd.fromImdb", { attributes: { imdbID } }),
      ),
    capacity: 4096,
    timeToLive: "3 days",
  })

  return { fromImdb } as const
}).pipe(Effect.withConfigProvider(configProviderNested("omdb")))

export class Ombd extends Context.Tag("Ombd")<
  Ombd,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.effect(Ombd, make)
}

export class Movie extends S.Class<Movie>("Movie")({
  Title: S.String,
  Year: S.String,
  Rated: S.String,
  Released: S.String,
  Runtime: S.String,
  Genre: S.String,
  Director: S.String,
  Writer: S.String,
  Actors: S.String,
  Plot: S.String,
  Language: S.String,
  Country: S.String,
  Awards: S.String,
  imdbRating: S.String,
  imdbID: S.String,
}) {
  static decodeResponse = HttpClientResponse.schemaBodyJsonScoped(this)

  get movieQuery() {
    return `${this.Title} ${this.Year}`
  }
}
