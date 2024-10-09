import { Array, Data, Effect, Option, PrimaryKey, Schedule } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import * as S from "@effect/schema/Schema"
import { EpisodeData, Tvdb } from "./Tvdb.js"
import {
  AbsoluteSeriesQuery,
  ImdbAbsoluteSeriesQuery,
  MovieQuery,
  SeasonQuery,
  SeriesQuery,
} from "./Domain/VideoQuery.js"
import * as PersistedCache from "@effect/experimental/PersistedCache"
import { Schema, Serializable } from "@effect/schema"
import { PersistenceLive } from "./Persistence.js"

export class Cinemeta extends Effect.Service<Cinemeta>()("Cinemeta", {
  scoped: Effect.gen(function* () {
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

    class LookupMovie extends Data.Class<{ imdbId: string }> {
      [PrimaryKey.symbol]() {
        return this.imdbId
      }
      get [Serializable.symbolResult]() {
        return {
          success: MovieMeta,
          failure: Schema.Never,
        }
      }
    }

    const lookupMovieCache = yield* PersistedCache.make({
      storeId: "Cinemeta.lookupMovie",
      lookup: (req: LookupMovie) =>
        client.get(`/movie/${req.imdbId}.json`).pipe(
          Effect.flatMap(Movie.decodeResponse),
          Effect.scoped,
          Effect.map(_ => _.meta),
          Effect.orDie,
          Effect.withSpan("Cinemeta.lookupMovie", { attributes: { ...req } }),
        ),
      timeToLive: (_, exit) =>
        exit._tag === "Success" ? "1 week" : "5 minutes",
      inMemoryCapacity: 8,
    })
    const lookupMovie = (imdbID: string) =>
      lookupMovieCache.get(new LookupMovie({ imdbId: imdbID }))

    class LookupSeries extends Data.Class<{ imdbID: string }> {
      [PrimaryKey.symbol]() {
        return this.imdbID
      }
      get [Serializable.symbolResult]() {
        return {
          success: SeriesMeta,
          failure: Schema.Never,
        }
      }
    }
    const lookupSeriesCache = yield* PersistedCache.make({
      storeId: "Cinemeta.lookupSeries",
      lookup: ({ imdbID }: LookupSeries) =>
        client.get(`/series/${imdbID}.json`).pipe(
          Effect.flatMap(Series.decodeResponse),
          Effect.scoped,
          Effect.map(_ => _.meta),
          Effect.orDie,
          Effect.withSpan("Cinemeta.lookupSeries", { attributes: { imdbID } }),
        ),
      timeToLive: (_, exit) =>
        exit._tag === "Success" ? "12 hours" : "5 minutes",
      inMemoryCapacity: 8,
    })
    const lookupSeries = (imdbID: string) =>
      lookupSeriesCache.get(new LookupSeries({ imdbID }))

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
  }),
  dependencies: [Tvdb.Default, PersistenceLive],
}) {}

export class Video extends S.Class<Video>("Video")({
  season: S.Number,
  number: S.Number,
  tvdb_id: S.optional(S.Union(S.Number, S.Null)),
  id: S.String,
  episode: S.Number,
}) {}

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
  imdb_id: S.String,
  name: S.String,
  tvdb_id: S.optional(S.Union(S.Number, S.Null)),
  id: S.String,
  genres: S.Array(S.String),
  videos: S.Array(Video),
}) {
  findEpisode(season: number, episode: number) {
    return Array.findFirst(
      this.videos,
      _ => _.season === season && _.episode === episode,
    )
  }
  absoluteQueries(
    season: number,
    episode: number,
  ): Option.Option<Array<AbsoluteSeriesQuery | ImdbAbsoluteSeriesQuery>> {
    const index = this.videos
      .filter(_ => _.season > 0)
      .findIndex(_ => _.season === season && _.episode === episode)
    return index > 0
      ? Option.some([
          new AbsoluteSeriesQuery({ title: this.name, number: index + 1 }),
          new ImdbAbsoluteSeriesQuery({
            imdbId: this.imdb_id,
            number: index + 1,
          }),
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
      Option.map(info => [
        new AbsoluteSeriesQuery({
          title: this.series.name,
          number: info.absoluteNumber,
        }),
        new ImdbAbsoluteSeriesQuery({
          imdbId: this.series.imdb_id,
          number: info.absoluteNumber,
        }),
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
      onSome: absolute => [...absolute, series, ...seasons],
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
