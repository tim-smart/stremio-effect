import { Data, Option } from "effect"

export type VideoQueryCategory = "series" | "movie"

export class SeriesQuery extends Data.TaggedClass("SeriesQuery")<{
  readonly title: string
  readonly season: number
  readonly episode: number
}> {
  get category(): VideoQueryCategory {
    return "series"
  }
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
  get category(): VideoQueryCategory {
    return "series"
  }
  get titleMatcher() {
    return Option.some(episodeTitleMatcher(this.number.toString()))
  }
  get asQuery() {
    return `${this.title} ${this.number}`
  }
}

export class ImdbSeriesQuery extends Data.TaggedClass("ImdbSeriesQuery")<{
  readonly imdbId: string
  readonly season: number
  readonly episode: number
}> {
  get category(): VideoQueryCategory {
    return "series"
  }
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
  get category(): VideoQueryCategory {
    return "series"
  }
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
}> {
  get category(): VideoQueryCategory {
    return "series"
  }
  get titleMatcher() {
    return Option.some(episodeTitleMatcher(seasonString(this.season)))
  }
  get asQuery() {
    return `${this.title} ${seasonString(this.season)}`
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
  get category(): VideoQueryCategory {
    return "series"
  }
  get titleMatcher() {
    return Option.some(episodeTitleMatcher(seasonString(this.season)))
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
  get category(): VideoQueryCategory {
    return "movie"
  }
  get asQuery() {
    return this.title
  }
  get titleMatcher() {
    return Option.none()
  }
}

export class ImdbMovieQuery extends Data.TaggedClass("MovieQuery")<{
  readonly imdbId: string
}> {
  get category(): VideoQueryCategory {
    return "movie"
  }
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

export type ImdbVideoQuery = ImdbMovieQuery | ImdbSeasonQuery | ImdbSeriesQuery

// helpers

const episodeTitleMatcher = (query: string) => {
  const regex = new RegExp(`(?:^|[^A-z0-9-])${query}(?:$|[^A-z0-9-])`, "i")
  return (title: string) => regex.test(title)
}
const seasonString = (season: number) => {
  return `S${season.toString().padStart(2, "0")}`
}

export const formatEpisode = (season: number, episode: number) =>
  `S${season.toString().padStart(2, "0")}E${episode.toString().padStart(2, "0")}`
