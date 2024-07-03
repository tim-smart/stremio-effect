import { Schema, Serializable } from "@effect/schema"
import { Data, Exit, Option, Predicate, PrimaryKey } from "effect"
import { SourceStream } from "./SourceStream.js"
import { TimeToLive } from "@effect/experimental"

export class SeriesQuery extends Data.TaggedClass("SeriesQuery")<{
  readonly title: string
  readonly season: number
  readonly episode: number
}> {
  get titleMatcher() {
    return Option.some(
      episodeTitleMatcher(formatEpisode(this.season, this.episode)),
    )
  }
  get asQuery() {
    return `${this.title} ${formatEpisode(this.season, this.episode)}`
  }
}

export class AbsoluteSeriesQuery extends Data.TaggedClass(
  "AbsoluteSeriesQuery",
)<{
  readonly title: string
  readonly number: number
}> {
  get titleMatcher() {
    return Option.some(episodeTitleMatcher(this.number.toString()))
  }
  get asQuery() {
    return `${this.title} ${this.number}`
  }
  [PrimaryKey.symbol]() {
    return `${this.title}/${this.number}`
  }
  [TimeToLive.symbol](exit: Exit.Exit<Array<SourceStream>, unknown>) {
    if (exit._tag === "Failure") return "1 minute"
    return exit.value.length > 0 ? "1 day" : "1 hour"
  }
  get [Serializable.symbolResult]() {
    return {
      Success: SourceStream.Array,
      Failure: Schema.Never,
    }
  }
}

export class ImdbSeriesQuery extends Data.TaggedClass("ImdbSeriesQuery")<{
  readonly imdbId: string
  readonly season: number
  readonly episode: number
}> {
  get titleMatcher() {
    return Option.some(
      episodeTitleMatcher(formatEpisode(this.season, this.episode)),
    )
  }
  get asQuery() {
    return this.imdbId
  }
}

export class ImdbAbsoluteSeriesQuery extends Data.TaggedClass(
  "ImdbAbsoluteSeriesQuery",
)<{
  readonly imdbId: string
  readonly number: number
}> {
  get titleMatcher() {
    return Option.some(episodeTitleMatcher(this.number.toString()))
  }
  get asQuery() {
    return this.imdbId
  }
}

export class SeasonQuery extends Data.TaggedClass("SeasonQuery")<{
  readonly title: string
  readonly season: number
  readonly episode: number
  readonly seasonString: string
}> {
  static variants = (props: {
    readonly title: string
    readonly season: number
    readonly episode: number
  }) => [
    new SeasonQuery({
      ...props,
      seasonString: seasonString(props.season),
    }),
    new SeasonQuery({
      ...props,
      seasonString: `Season ${props.season}`,
    }),
  ]

  get asQuery() {
    return `${this.title} ${this.seasonString}`
  }
  get titleMatcher() {
    return Option.some(episodeTitleMatcher(this.seasonString))
  }
  get seriesQuery() {
    return new SeriesQuery({
      title: this.title,
      season: this.season,
      episode: this.episode,
    })
  }
}

export class ImdbSeasonQuery extends Data.TaggedClass("ImdbSeasonQuery")<{
  readonly imdbId: string
  readonly season: number
  readonly episode: number
}> {
  get titleMatcher() {
    return Option.some(seasonTitleMatcher(this.season))
  }
  get asQuery() {
    return this.imdbId
  }
  get seriesQuery() {
    return new ImdbSeriesQuery({
      imdbId: this.imdbId,
      season: this.season,
      episode: this.episode,
    })
  }
}

export class MovieQuery extends Data.TaggedClass("MovieQuery")<{
  readonly title: string
}> {
  get asQuery() {
    return this.title
  }
  get titleMatcher() {
    return Option.none()
  }
}

export class ImdbMovieQuery extends Data.TaggedClass("ImbdMovieQuery")<{
  readonly imdbId: string
}> {
  get asQuery() {
    return this.imdbId
  }
  get titleMatcher() {
    return Option.none()
  }
}

export class ChannelQuery extends Data.TaggedClass("ChannelQuery")<{
  readonly id: string
}> {
  get asQuery() {
    return this.id
  }
  get titleMatcher() {
    return Option.none()
  }
}

export class ImdbTvQuery extends Data.TaggedClass("TvQuery")<{
  readonly imdbId: string
}> {
  get asQuery() {
    return this.imdbId
  }
  get titleMatcher() {
    return Option.none()
  }
}

export type VideoQuery =
  | AbsoluteSeriesQuery
  | ChannelQuery
  | MovieQuery
  | SeasonQuery
  | SeriesQuery
  | ImdbTvQuery
  | ImdbAbsoluteSeriesQuery
  | ImdbMovieQuery
  | ImdbSeasonQuery
  | ImdbSeriesQuery

export type AllSeasonQuery = SeasonQuery | ImdbSeasonQuery
export type TitleVideoQuery =
  | MovieQuery
  | SeriesQuery
  | SeasonQuery
  | AbsoluteSeriesQuery
export type ImdbVideoQuery =
  | ImdbMovieQuery
  | ImdbSeasonQuery
  | ImdbSeriesQuery
  | ImdbAbsoluteSeriesQuery

// helpers

const episodeTitleMatcher = (query: string) => {
  const regex = new RegExp(`(?:^|[^A-z0-9-])${query}(?:$|[^A-z0-9-])`, "i")
  return (title: string) => regex.test(title)
}

const seasonTitleMatcher = (season: number) =>
  Predicate.or(
    episodeTitleMatcher(seasonString(season)),
    episodeTitleMatcher(`Season ${season}`),
  )

const seasonString = (season: number) => {
  return `S${season.toString().padStart(2, "0")}`
}

export const formatEpisode = (season: number, episode: number) =>
  `S${season.toString().padStart(2, "0")}E${episode.toString().padStart(2, "0")}`

export const isSeasonQuery = (query: VideoQuery): query is AllSeasonQuery =>
  query._tag === "SeasonQuery" || query._tag === "ImdbSeasonQuery"

export const nonSeasonQuery = (query: VideoQuery) =>
  isSeasonQuery(query) ? query.seriesQuery : query
