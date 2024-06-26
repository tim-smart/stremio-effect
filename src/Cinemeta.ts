import { Array, Context, Effect, flow, Layer } from "effect"
import { cacheWithSpan, configProviderNested, formatEpisode } from "./Utils.js"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import * as S from "@effect/schema/Schema"
import { Tvdb } from "./Tvdb.js"

const make = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(HttpClientRequest.prependUrl("https://v3-cinemeta.strem.io/meta")),
    ),
    HttpClient.filterStatusOk,
  )

  const lookupMovie = yield* cacheWithSpan({
    lookup: (imdbID: string) =>
      HttpClientRequest.get(`/movie/${imdbID}.json`).pipe(
        client,
        Movie.decodeResponse,
        Effect.map(_ => _.meta),
        Effect.withSpan("Cinemeta.lookupMovie", { attributes: { imdbID } }),
      ),
    capacity: 1024,
    timeToLive: "3 days",
  })

  const lookupSeries = yield* cacheWithSpan({
    lookup: (imdbID: string) =>
      HttpClientRequest.get(`/series/${imdbID}.json`).pipe(
        client,
        Series.decodeResponse,
        Effect.map(_ => _.meta),
        Effect.withSpan("Cinemeta.lookupSeries", { attributes: { imdbID } }),
      ),
    capacity: 1024,
    timeToLive: "12 hours",
  })

  const tvdb = yield* Tvdb
  const lookupEpisode = (imdbID: string, season: number, episode: number) =>
    Effect.gen(function* () {
      const series = yield* lookupSeries(imdbID)
      const info = yield* series.findEpisode(season, episode).pipe(
        Effect.flatMap(_ => Effect.fromNullable(_.tvdb_id)),
        Effect.flatMap(tvdb.lookupEpisode),
        Effect.option,
      )
      return { series, episode: info } as const
    })

  return { lookupMovie, lookupSeries, lookupEpisode } as const
}).pipe(Effect.withConfigProvider(configProviderNested("omdb")))

export class Cinemeta extends Context.Tag("Cinemeta")<
  Cinemeta,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.effect(Cinemeta, make).pipe(Layer.provide(Tvdb.Live))
}

export class Video extends S.Class<Video>("Video")({
  name: S.optional(S.Union(S.Null, S.String)),
  season: S.Number,
  number: S.Number,
  firstAired: S.optional(S.Union(S.Null, S.String)),
  tvdb_id: S.optional(S.Union(S.Number, S.Null)),
  rating: S.optional(S.Union(S.Null, S.String)),
  overview: S.String,
  thumbnail: S.String,
  id: S.String,
  released: S.String,
  episode: S.Number,
  description: S.optional(S.Union(S.Null, S.String)),
  title: S.optional(S.Union(S.Null, S.String)),
  moviedb_id: S.optional(S.Union(S.Number, S.Null)),
}) {}

export class TrailerStream extends S.Class<TrailerStream>("TrailerStream")({
  title: S.String,
  ytId: S.String,
}) {}

export class MovieMeta extends S.Class<MovieMeta>("MovieMeta")({
  id: S.String,
  imdb_id: S.String,
  type: S.String,
  poster: S.String,
  logo: S.String,
  background: S.String,
  moviedb_id: S.Number,
  name: S.String,
  description: S.String,
  genres: S.Array(S.String),
  releaseInfo: S.String,
  runtime: S.String,
  cast: S.Array(S.String),
  director: S.Array(S.String),
  language: S.String,
  country: S.String,
  imdbRating: S.String,
  slug: S.String,
}) {}

export class Movie extends S.Class<Movie>("Movie")({
  meta: MovieMeta,
}) {
  static decodeResponse = HttpClientResponse.schemaBodyJsonScoped(this)
}

export class SeriesMeta extends S.Class<SeriesMeta>("SeriesMeta")({
  awards: S.String,
  cast: S.Array(S.String),
  country: S.String,
  description: S.String,
  director: S.Union(S.Array(S.Any), S.Null),
  dvdRelease: S.optional(S.Null),
  genre: S.optional(S.Union(S.Array(S.String), S.Null)),
  imdbRating: S.String,
  imdb_id: S.String,
  name: S.String,
  popularity: S.optional(S.Union(S.Number, S.Null)),
  poster: S.String,
  released: S.optional(S.Union(S.Null, S.String)),
  runtime: S.optional(S.Union(S.Null, S.String)),
  status: S.String,
  tvdb_id: S.optional(S.Union(S.Number, S.Null)),
  type: S.String,
  writer: S.optional(S.Union(S.Array(S.String), S.Null)),
  year: S.optional(S.Union(S.Null, S.String)),
  background: S.String,
  logo: S.String,
  popularities: S.optional(S.Union(S.Record(S.String, S.Number), S.Null)),
  moviedb_id: S.Number,
  slug: S.String,
  id: S.String,
  genres: S.Array(S.String),
  releaseInfo: S.String,
  videos: S.Array(Video),
  trailerStreams: S.optional(S.Union(S.Array(TrailerStream), S.Null)),
  language: S.optional(S.Union(S.Null, S.String)),
}) {
  findEpisode(season: number, episode: number) {
    return Array.findFirst(
      this.videos,
      _ => _.season === season && _.episode === episode,
    )
  }

  queries(season: number, episode: number): ReadonlyArray<string> {
    const episodeIndex = this.videos
      .filter(_ => _.season > 0)
      .findIndex(_ => _.season === season && _.episode === episode)
    if (episodeIndex === -1) {
      return [`${this.name} ${formatEpisode(season, episode)}`]
    }
    const episodeNumber = episodeIndex + 1
    return [
      `${this.name} ${formatEpisode(season, episode)}`,
      `${this.name} ${episodeNumber}`,
    ]
  }
}

export class Series extends S.Class<Series>("Series")({
  meta: SeriesMeta,
}) {
  static decodeResponse = HttpClientResponse.schemaBodyJsonScoped(this)
}
