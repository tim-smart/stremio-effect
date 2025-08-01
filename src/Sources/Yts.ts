import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { Effect, Layer, pipe, Schedule } from "effect"
import { SourceStream } from "../Domain/SourceStream.js"
import { VideoQuery } from "../Domain/VideoQuery.js"
import { Sources } from "../Sources.js"
import { magnetFromHash } from "../Utils.js"
import { Schema as S } from "effect/schema"
import { Data } from "effect/data"
import { Cache } from "effect/caching"
import { Match } from "effect/match"
import { Stream } from "effect/stream"

export const SourceYtsLive = Effect.gen(function* () {
  const sources = yield* Sources
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.mapRequest(
      HttpClientRequest.prependUrl("https://yts.mx/api/v2"),
    ),
    HttpClient.retryTransient({
      times: 5,
      schedule: Schedule.exponential(100),
    }),
  )

  class DetailsRequest extends Data.Class<{ imdbId: string }> {
    // [PrimaryKey.symbol]() {
    //   return this.imdbId
    // }
  }

  const details = yield* Cache.makeWith({
    // storeId: "Source.Yts.details",
    lookup: ({ imdbId }: DetailsRequest) =>
      pipe(
        client.get("/movie_details.json", { urlParams: { imdb_id: imdbId } }),
        Effect.flatMap(MovieDetails.decodeResponse),
        Effect.orDie,
        Effect.map((_) => _.data.movie),
        Effect.withSpan("Source.Yts.details", { attributes: { imdbId } }),
      ),
    timeToLive: (exit) => {
      if (exit._tag === "Failure") return "5 minutes"
      return "3 days"
    },
    capacity: 128,
  })

  yield* sources.register({
    name: "YTS",
    list: Match.type<VideoQuery>().pipe(
      Match.tag("ImbdMovieQuery", ({ imdbId }) =>
        Cache.get(details, new DetailsRequest({ imdbId })).pipe(
          Effect.map((_) => _.streams),
          Effect.tapCause(Effect.logDebug),
          Effect.orElseSucceed(() => []),
          Effect.withSpan("Source.Yts.Imdb", { attributes: { imdbId } }),
          Effect.annotateLogs({
            service: "Source.Yts",
            method: "list",
            kind: "Imdb",
          }),
          Stream.fromIterableEffect,
        ),
      ),
      Match.orElse(() => Stream.empty),
    ),
  })
}).pipe(Layer.effectDiscard, Layer.provide(Sources.layer))

// schema

export const Quality = S.Literals([
  "480p",
  "720p",
  "1080p",
  "1080p.x265",
  "2160p",
  "3D",
])
export type Quality = S.Schema.Type<typeof Quality>

export class Torrent extends S.Class<Torrent>("Torrent")({
  url: S.String,
  hash: S.String,
  quality: Quality,
  is_repack: S.String,
  bit_depth: S.String,
  audio_channels: S.String,
  seeds: S.Number,
  peers: S.Number,
  size: S.String,
  size_bytes: S.Number,
  date_uploaded: S.String,
  date_uploaded_unix: S.Number,
}) {}

export class Movie extends S.Class<Movie>("Movie")({
  id: S.Number,
  url: S.String,
  imdb_code: S.String,
  title: S.NullOr(S.String),
  title_english: S.NullOr(S.String),
  title_long: S.String,
  slug: S.NullOr(S.String),
  year: S.Number,
  rating: S.Number,
  runtime: S.Number,
  torrents: S.optional(S.NullOr(S.Array(Torrent))),
}) {
  get streams(): SourceStream[] {
    if (!this.torrents) {
      return []
    }
    return this.torrents.map(
      (tor) =>
        new SourceStream({
          source: "YTS",
          title: this.title || this.title_long,
          infoHash: tor.hash,
          magnetUri: magnetFromHash(tor.hash),
          quality: tor.quality,
          seeds: tor.seeds,
          peers: tor.peers,
          sizeBytes: tor.size_bytes,
        }),
    )
  }
}

export class MovieDetailsData extends S.Class<MovieDetailsData>(
  "MovieDetailsData",
)({
  movie: Movie,
}) {}

export class ListMoviesData extends S.Class<ListMoviesData>("ListMoviesData")({
  movie_count: S.Number,
  limit: S.Number,
  page_number: S.Number,
  movies: S.Array(Movie),
}) {}

export class MovieDetails extends S.Class<MovieDetails>("MovieDetails")({
  status_message: S.String,
  data: MovieDetailsData,
}) {
  static decodeResponse = HttpClientResponse.schemaBodyJson(this)
}
