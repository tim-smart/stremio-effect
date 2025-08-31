import { Effect, Layer, Schedule, ServiceMap } from "effect"
import { Cache } from "effect/caching"
import {
  AbsoluteSeriesQuery,
  ImdbAbsoluteSeriesQuery,
  MovieQuery,
  SeasonQuery,
  SeriesQuery,
} from "./Domain/VideoQuery.js"
import { EpisodeData, Tvdb } from "./Tvdb.js"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { Data, Option } from "effect/data"
import { Schema as S } from "effect/schema"
import { Array } from "effect/collections"

export class Cinemeta extends ServiceMap.Key<Cinemeta>()("Cinemeta", {
  make: Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        HttpClientRequest.prependUrl("https://v3-cinemeta.strem.io/meta"),
      ),
      HttpClient.followRedirects(),
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({
        times: 5,
        schedule: Schedule.exponential(100),
      }),
    )

    const lookupMovieCache = yield* Cache.makeWith({
      lookup: (imdbId: string) =>
        client.get(`/movie/${imdbId}.json`).pipe(
          Effect.flatMap(Movie.decodeResponse),
          Effect.map((_) => _.meta),
          Effect.orDie,
          Effect.withSpan("Cinemeta.lookupMovie", { attributes: { imdbId } }),
        ),
      capacity: 1024,
      timeToLive: (exit) => (exit._tag === "Success" ? "1 week" : "5 minutes"),
    })
    const lookupMovie = (imdbID: string) => Cache.get(lookupMovieCache, imdbID)

    const lookupSeriesCache = yield* Cache.makeWith({
      lookup: (imdbID: string) =>
        client.get(`/series/${imdbID}.json`).pipe(
          Effect.flatMap(Series.decodeResponse),
          Effect.map((_) => _.meta),
          Effect.orDie,
          Effect.withSpan("Cinemeta.lookupSeries", { attributes: { imdbID } }),
        ),
      timeToLive: (exit) =>
        exit._tag === "Success" ? "12 hours" : "5 minutes",
      capacity: 1024,
    })
    const lookupSeries = (imdbID: string) =>
      Cache.get(lookupSeriesCache, imdbID)

    const tvdb = yield* Tvdb
    const lookupEpisode = Effect.fnUntraced(
      function* (imdbID: string, season: number, episode: number) {
        const series = yield* lookupSeries(imdbID)
        if (series.videos[0]?.episode === undefined) {
          return [
            new GeneralEpisodeResult({
              series,
              season,
              episode,
            }),
            new AnimationEpisodeResult({
              series,
              season,
              episode,
              info: Option.none(),
            }),
          ]
        } else if (!series.genres?.includes("Animation")) {
          return [
            new GeneralEpisodeResult({
              series,
              season,
              episode,
            }),
          ]
        }
        const info = yield* series
          .findEpisode(season, episode)
          .asEffect()
          .pipe(
            Effect.flatMap((_) => Effect.fromNullishOr(_.tvdb_id)),
            Effect.flatMap(tvdb.lookupEpisode),
            Effect.option,
          )
        return [
          new AnimationEpisodeResult({
            series,
            season,
            episode,
            info,
          }),
        ]
      },
      (effect, imdbID, season, episode) =>
        Effect.withSpan(effect, "Cinemeta.lookupEpisode", {
          attributes: { imdbID, season, episode },
        }),
    )

    return { lookupMovie, lookupSeries, lookupEpisode } as const
  }),
}) {
  static layer = Layer.effect(this)(this.make).pipe(Layer.provide(Tvdb.layer))
}

export class Video extends S.Class<Video>("Video")({
  season: S.Number,
  number: S.Number,
  tvdb_id: S.optional(S.Union([S.Number, S.FiniteFromString, S.Null])),
  id: S.String,
  episode: S.optional(S.Number),
}) {
  get episodeOrNumber() {
    return this.episode ?? this.number
  }
}

export class MovieMeta extends S.Class<MovieMeta>("MovieMeta")({
  id: S.String,
  imdb_id: S.String,
  name: S.String,
}) {
  get queries() {
    return [new MovieQuery({ title: this.name })]
  }
}

export class Movie extends S.Class<Movie>("Movie")({
  meta: MovieMeta,
}) {
  static decodeResponse = HttpClientResponse.schemaBodyJson(this)
}

export class SeriesMeta extends S.Class<SeriesMeta>("SeriesMeta")({
  imdb_id: S.optional(S.String),
  name: S.String,
  tvdb_id: S.optional(S.Union([S.Number, S.FiniteFromString, S.Null])),
  id: S.String,
  genres: S.Array(S.String).pipe(S.optionalKey),
  videos: S.Array(Video),
}) {
  findEpisode(season: number, episode: number) {
    return Array.findFirst(
      this.videos,
      (_) => _.season === season && _.episodeOrNumber === episode,
    )
  }
  absoluteQueries(
    season: number,
    episode: number,
  ): Option.Option<Array<AbsoluteSeriesQuery | ImdbAbsoluteSeriesQuery>> {
    const index = this.videos
      .filter((_) => _.season > 0)
      .findIndex((_) => _.season === season && _.episodeOrNumber === episode)
    return index >= 0
      ? Option.some([
          new AbsoluteSeriesQuery({ title: this.name, number: index + 1 }),
          ...(this.imdb_id
            ? [
                new ImdbAbsoluteSeriesQuery({
                  imdbId: this.imdb_id,
                  number: index + 1,
                }),
              ]
            : []),
        ])
      : Option.none()
  }
}

export class Series extends S.Class<Series>("Series")({
  meta: SeriesMeta,
}) {
  static decodeResponse = HttpClientResponse.schemaBodyJson(this)
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
  get absoluteQueries() {
    return this.info.pipe(
      Option.map((info) => [
        new AbsoluteSeriesQuery({
          title: this.series.name,
          number: info.absoluteNumber,
        }),
        ...(this.series.imdb_id
          ? [
              new ImdbAbsoluteSeriesQuery({
                imdbId: this.series.imdb_id,
                number: info.absoluteNumber,
              }),
            ]
          : []),
      ]),
      Option.orElse(() =>
        this.series.absoluteQueries(this.season, this.episode),
      ),
    )
  }
  get queries() {
    const series = new SeriesQuery({
      title: this.series.name,
      season: this.season,
      episode: this.episode,
    })
    const seasons = SeasonQuery.variants({
      title: this.series.name,
      season: this.season,
      episode: this.episode,
    })
    return Option.match(this.absoluteQueries, {
      onNone: () => [series, ...seasons],
      onSome: (absolute) => [...absolute, series, ...seasons],
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
        season: this.season,
        episode: this.episode,
      }),
      ...SeasonQuery.variants({
        title: this.series.name,
        season: this.season,
        episode: this.episode,
      }),
    ]
  }
}

export type EpisodeResult = AnimationEpisodeResult | GeneralEpisodeResult
