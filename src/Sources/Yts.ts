import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import {
  Effect,
  Exit,
  Hash,
  Layer,
  Match,
  PrimaryKey,
  Schedule,
  Stream,
} from "effect"
import { Sources } from "../Sources.js"
import * as S from "@effect/schema/Schema"
import { magnetFromHash } from "../Utils.js"
import { SourceStream } from "../Domain/SourceStream.js"
import { VideoQuery } from "../Domain/VideoQuery.js"
import { Schema } from "@effect/schema"
import { PersistedCache, TimeToLive } from "@effect/experimental"

export const SourceYtsLive = Effect.gen(function* () {
  const sources = yield* Sources
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.mapRequest(
      HttpClientRequest.prependUrl("https://yts.mx/api/v2"),
    ),
    HttpClient.transformResponse(
      Effect.retry({
        while: err =>
          err._tag === "ResponseError" && err.response.status >= 429,
        times: 5,
        schedule: Schedule.exponential(100),
      }),
    ),
  )

  class DetailsRequest extends Schema.TaggedRequest<DetailsRequest>()(
    "DetailsRequest",
    Schema.Never,
    Movie,
    { imdbId: Schema.String },
  ) {
    [PrimaryKey.symbol]() {
      return Hash.hash(this).toString()
    }
    [TimeToLive.symbol](exit: Exit.Exit<Array<Movie>, unknown>) {
      if (exit._tag === "Failure") return "5 minutes"
      return exit.value.length > 0 ? "3 days" : "6 hours"
    }
  }

  const details = yield* PersistedCache.make({
    storeId: "Source.Yts.details",
    lookup: ({ imdbId }: DetailsRequest) =>
      HttpClientRequest.get("/movie_details.json").pipe(
        HttpClientRequest.setUrlParam("imdb_id", imdbId),
        client,
        MovieDetails.decodeResponse,
        Effect.orDie,
        Effect.map(_ => _.data.movie),
        Effect.withSpan("Source.Yts.details", { attributes: { imdbId } }),
      ),
    inMemoryCapacity: 8,
  })

  yield* sources.register({
    list: Match.type<VideoQuery>().pipe(
      Match.tag("ImbdMovieQuery", ({ imdbId }) =>
        details.get(new DetailsRequest({ imdbId })).pipe(
          Effect.map(_ => _.streams),
          Effect.tapErrorCause(Effect.logDebug),
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
}).pipe(Layer.scopedDiscard, Layer.provide(Sources.Live))

// schema

export const Quality = S.Literal(
  "480p",
  "720p",
  "1080p",
  "1080p.x265",
  "2160p",
  "3D",
)
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
  title: S.Union(S.Null, S.String),
  title_english: S.Union(S.Null, S.String),
  title_long: S.String,
  slug: S.Union(S.Null, S.String),
  year: S.Number,
  rating: S.Number,
  runtime: S.Number,
  torrents: S.optional(S.Union(S.Array(Torrent), S.Null)),
}) {
  get streams(): SourceStream[] {
    if (!this.torrents) {
      return []
    }
    return this.torrents.map(
      tor =>
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
  static decodeResponse = HttpClientResponse.schemaBodyJsonScoped(this)
}
