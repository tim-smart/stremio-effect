import { Data, Option, Predicate } from "effect"
import { NonEmptyReadonlyArray } from "effect/Array"

export type VideoQueryCategory = "series" | "movie"

export type EpisodeQuery = SeasonEpisodeQuery | AbsoluteEpisodeQuery

export class AbsoluteEpisodeQuery extends Data.TaggedClass("AbsoluteEpisode")<{
  readonly number: number
}> {
  get asQuery() {
    return this.number.toString()
  }
  get asMatcher() {
    return episodeTitleMatcher(this.asQuery)
  }
}

export class SeasonEpisodeQuery extends Data.TaggedClass("SeasonEpisode")<{
  readonly season: number
  readonly episode: number
}> {
  get asQuery() {
    return formatEpisode(this.season, this.episode)
  }
  get asMatcher() {
    return episodeTitleMatcher(this.asQuery)
  }
}

export class SeriesQuery extends Data.TaggedClass("SeriesQuery")<{
  readonly title: string
  readonly episode: EpisodeQuery
}> {
  get category(): VideoQueryCategory {
    return "series"
  }
  get titleMatcher() {
    return Option.some(this.episode.asMatcher)
  }
  get asQuery() {
    return `${this.title} ${this.episode.asQuery}`
  }
}

export class ImdbSeriesQuery extends Data.TaggedClass("SeriesQuery")<{
  readonly imdbId: string
  readonly episodeQueries: NonEmptyReadonlyArray<EpisodeQuery>
}> {
  get category(): VideoQueryCategory {
    return "series"
  }
  get titleMatcher() {
    return Option.some(
      this.episodeQueries.map(_ => _.asMatcher).reduce(Predicate.and),
    )
  }
  get asQuery() {
    return this.imdbId
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

export type VideoQuery = SeriesQuery | MovieQuery
export type ImdbVideoQuery = ImdbSeriesQuery | ImdbMovieQuery

// helpers

const episodeTitleMatcher = (query: string) => {
  const regex = new RegExp(`(?:^|[^A-z0-9-])${query}(?:$|[^A-z0-9-])`, "i")
  return (title: string) => regex.test(title)
}

export const formatEpisode = (season: number, episode: number) =>
  `S${season.toString().padStart(2, "0")}E${episode.toString().padStart(2, "0")}`
