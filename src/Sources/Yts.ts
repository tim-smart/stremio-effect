import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Effect, Layer } from "effect"
import { Sources, SourceStream } from "../Sources.js"
import { StreamRequest } from "../Stremio.js"
import * as S from "@effect/schema/Schema"
import { magnetFromHash } from "../Utils.js"

export const SourceYtsLive = Effect.gen(function* () {
  const sources = yield* Sources
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      HttpClientRequest.prependUrl("https://yts.mx/api/v2"),
    ),
  )

  const details = (imdbId: string) =>
    HttpClientRequest.get("/movie_details.json").pipe(
      HttpClientRequest.setUrlParam("imdb_id", imdbId),
      client,
      MovieDetails.decodeResponse,
      Effect.map(_ => _.data.movie),
    )

  yield* sources.register({
    list: StreamRequest.$match({
      Channel: () => Effect.succeed([]),
      Movie: ({ imdbId }) =>
        details(imdbId).pipe(
          Effect.map(_ => _.streams),
          Effect.tapErrorCause(Effect.logDebug),
          Effect.orElseSucceed(() => []),
          Effect.withSpan("Source.Yts.list", { attributes: { imdbId } }),
          Effect.annotateLogs({
            service: "Source.Yts",
            method: "list",
          }),
        ),
      Series: () => Effect.succeed([]),
      Tv: () => Effect.succeed([]),
    }),
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
}) {
  get asStream() {
    return new SourceStream({
      source: "YTS",
      infoHash: this.hash,
      magnetUri: magnetFromHash(this.hash),
      quality: this.quality,
      seeds: this.seeds,
      peers: this.peers,
      sizeBytes: this.size_bytes,
    })
  }
}

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
    return this.torrents.map(_ => _.asStream)
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
