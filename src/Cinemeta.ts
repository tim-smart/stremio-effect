import { Array, Context, Data, Effect, Layer, Option } from "effect"
import { cacheWithSpan } from "./Utils.js"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import * as S from "@effect/schema/Schema"
import { EpisodeData, Tvdb } from "./Tvdb.js"
import {
  AbsoluteEpisodeQuery,
  EpisodeQuery,
  ImdbSeriesQuery,
  MovieQuery,
  SeasonEpisodeQuery,
  SeriesQuery,
} from "./Domain/VideoQuery.js"
import { NonEmptyReadonlyArray } from "effect/Array"

const make = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      HttpClientRequest.prependUrl("https://v3-cinemeta.strem.io/meta"),
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
      if (!series.genres.includes("Animation")) {
        return new GeneralEpisodeResult({
          series,
          season,
          episode,
        })
      }
      const info = yield* series.findEpisode(season, episode).pipe(
        Effect.flatMap(_ => Effect.fromNullable(_.tvdb_id)),
        Effect.flatMap(tvdb.lookupEpisode),
        Effect.option,
      )
      return new AnimationEpisodeResult({
        series,
        season,
        episode,
        info,
      })
    }).pipe(
      Effect.withSpan("Cinemeta.lookupEpisode", {
        attributes: { imdbID, season, episode },
      }),
    )

  return { lookupMovie, lookupSeries, lookupEpisode } as const
})

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
  background: S.String,
  moviedb_id: S.Number,
  name: S.String,
  description: S.String,
  genres: S.Array(S.String),
  releaseInfo: S.String,
  country: S.String,
  imdbRating: S.String,
  slug: S.String,
}) {
  get query() {
    return new MovieQuery({ title: this.name })
  }
}

export class Movie extends S.Class<Movie>("Movie")({
  meta: MovieMeta,
}) {
  static decodeResponse = HttpClientResponse.schemaBodyJsonScoped(this)
}

export class SeriesMeta extends S.Class<SeriesMeta>("SeriesMeta")({
  country: S.String,
  description: S.String,
  imdbRating: S.String,
  imdb_id: S.String,
  name: S.String,
  status: S.String,
  tvdb_id: S.optional(S.Union(S.Number, S.Null)),
  type: S.String,
  moviedb_id: S.Number,
  slug: S.String,
  id: S.String,
  genres: S.Array(S.String),
  releaseInfo: S.String,
  videos: S.Array(Video),
  trailerStreams: S.optional(S.Union(S.Array(TrailerStream), S.Null)),
}) {
  findEpisode(season: number, episode: number) {
    return Array.findFirst(
      this.videos,
      _ => _.season === season && _.episode === episode,
    )
  }
  absoluteEpisodeQuery(
    season: number,
    episode: number,
  ): Option.Option<AbsoluteEpisodeQuery> {
    const index = this.videos
      .filter(_ => _.season > 0)
      .findIndex(_ => _.season === season && _.episode === episode)
    return index > 0
      ? Option.some(new AbsoluteEpisodeQuery({ number: index + 1 }))
      : Option.none()
  }
  queries(season: number, episode: number): ReadonlyArray<SeriesQuery> {
    return [
      new SeriesQuery({
        title: this.name,
        episode: new SeasonEpisodeQuery({ season, episode }),
      }),
    ]
  }
}

export class Series extends S.Class<Series>("Series")({
  meta: SeriesMeta,
}) {
  static decodeResponse = HttpClientResponse.schemaBodyJsonScoped(this)
}

// episode result

export class AnimationEpisodeResult extends Data.TaggedClass(
  "AnimationEpisodeResult",
)<{
  series: SeriesMeta
  season: number
  episode: number
  info: Option.Option<EpisodeData>
}> {
  get absoluteEpisodeQuery() {
    return this.info.pipe(
      Option.map(
        info => new AbsoluteEpisodeQuery({ number: info.absoluteNumber }),
      ),
      Option.orElse(() =>
        this.series.absoluteEpisodeQuery(this.season, this.episode),
      ),
    )
  }
  get episodeQueries(): NonEmptyReadonlyArray<EpisodeQuery> {
    const season = new SeasonEpisodeQuery({
      season: this.season,
      episode: this.episode,
    })
    return Option.match(this.absoluteEpisodeQuery, {
      onSome: absolute => [season, absolute],
      onNone: () => [season],
    })
  }
  get absoluteQuery() {
    return new SeriesQuery({
      title: this.series.name,
      episode: Option.getOrElse(
        this.absoluteEpisodeQuery,
        () =>
          new SeasonEpisodeQuery({
            season: this.season,
            episode: this.episode,
          }),
      ),
    })
  }
  get queries() {
    return this.episodeQueries.map(
      episode =>
        new SeriesQuery({
          title: this.series.name,
          episode,
        }),
    )
  }
  get imdbQuery() {
    return new ImdbSeriesQuery({
      imdbId: this.series.imdb_id,
      episodeQueries: this.episodeQueries,
    })
  }
}

export class GeneralEpisodeResult extends Data.TaggedClass(
  "GeneralEpisodeResult",
)<{
  series: SeriesMeta
  season: number
  episode: number
}> {
  get queries() {
    return [
      new SeriesQuery({
        title: this.series.name,
        episode: new SeasonEpisodeQuery({
          season: this.season,
          episode: this.episode,
        }),
      }),
    ]
  }
  get episodeQueries() {
    return Array.of(
      new SeasonEpisodeQuery({
        season: this.season,
        episode: this.episode,
      }),
    )
  }
  get imdbQuery() {
    return new ImdbSeriesQuery({
      imdbId: this.series.imdb_id,
      episodeQueries: this.episodeQueries,
    })
  }
}

export type EpisodeResult = AnimationEpisodeResult | GeneralEpisodeResult
