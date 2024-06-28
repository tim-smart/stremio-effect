import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import {
  Array,
  Duration,
  Effect,
  flow,
  identity,
  Layer,
  pipe,
  Stream,
} from "effect"
import * as Cheerio from "cheerio"
import { Sources } from "../Sources.js"
import {
  cacheWithSpan,
  infoHashFromMagnet,
  qualityFromTitle,
} from "../Utils.js"
import { StreamRequest } from "../Stremio.js"
import { Cinemeta } from "../Cinemeta.js"
import { VideoQuery } from "../Domain/VideoQuery.js"
import { SourceStream } from "../Domain/SourceStream.js"

export const SourceRargbLive = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.mapRequest(
      flow(HttpClientRequest.prependUrl("https://rargb.to")),
    ),
  )

  const magnetLink = yield* cacheWithSpan({
    lookup: (url: string) =>
      HttpClientRequest.get(url).pipe(
        client,
        HttpClientResponse.text,
        Effect.flatMap(html => {
          const $ = Cheerio.load(html)
          return Effect.fromNullable(
            $("td.lista a[href^='magnet:']").attr("href"),
          )
        }),
      ),
    capacity: 4096,
    timeToLive: Duration.infinity,
  })

  const parseResults = (html: string) => {
    const $ = Cheerio.load(html)
    const table = $("table.lista2t")
    const streams: Array<{
      readonly url: string
      readonly title: string
      readonly size: string
      readonly seeds: number
      readonly peers: number
    }> = []
    table.find("tr.lista2").each((_, row) => {
      const $row = $(row)
      const cells = $row.find("> td")
      const link = cells.eq(1).find("a")
      streams.push({
        url: link.attr("href")!,
        title: link.attr("title")!,
        size: cells.eq(4).text(),
        seeds: +cells.eq(5).text(),
        peers: +cells.eq(6).text(),
      })
    })
    return streams
  }

  const searchCache = yield* cacheWithSpan({
    lookup: (request: VideoQuery) =>
      HttpClientRequest.get("/search/").pipe(
        HttpClientRequest.setUrlParams({
          search: request.asQuery,
          "category[]":
            request._tag === "MovieQuery" ? ["movies"] : ["tv", "anime"],
        }),
        client,
        HttpClientResponse.text,
        Effect.map(html => {
          let results = parseResults(html)
          const matcher = request.titleMatcher
          return matcher._tag === "Some"
            ? Array.filter(results, _ => matcher.value(_.title))
            : results
        }),
        Effect.withSpan("Source.Rarbg.search", { attributes: { ...request } }),
      ),
    capacity: 4096,
    timeToLive: "12 hours",
  })

  const searchStream = (request: VideoQuery) =>
    searchCache(request).pipe(
      Effect.map(Stream.fromIterable),
      Stream.unwrap,
      Stream.take(10),
      Stream.flatMap(
        result =>
          magnetLink(result.url).pipe(
            Effect.map(
              magnet =>
                new SourceStream({
                  source: "Rarbg",
                  infoHash: infoHashFromMagnet(magnet),
                  magnetUri: magnet,
                  quality: qualityFromTitle(result.title),
                  seeds: result.seeds,
                  peers: result.peers,
                  sizeDisplay: result.size,
                }),
            ),
            Stream.catchAllCause(() => Stream.empty),
          ),
        { concurrency: "unbounded" },
      ),
    )

  const cinemeta = yield* Cinemeta
  const sources = yield* Sources
  yield* sources.register({
    list: StreamRequest.$match({
      Channel: () => Stream.empty,
      Movie: ({ imdbId }) =>
        pipe(
          cinemeta.lookupMovie(imdbId),
          Effect.map(result => searchStream(result.query)),
          Stream.unwrap,
          Stream.catchAllCause(cause =>
            Effect.logDebug(cause).pipe(
              Effect.annotateLogs({
                service: "Source.Rarbg.Movie",
                imdbId,
              }),
              Stream.drain,
            ),
          ),
          Stream.withSpan("Source.Rarbg.Movie", { attributes: { imdbId } }),
        ),
      Series: ({ imdbId, season, episode }) =>
        pipe(
          cinemeta.lookupEpisode(imdbId, season, episode),
          Effect.map(result => Stream.fromIterable(result.queries)),
          Stream.unwrap,
          Stream.flatMap(searchStream),
          Stream.catchAllCause(cause =>
            Effect.logDebug(cause).pipe(
              Effect.annotateLogs({
                service: "Source.Rarbg.Series",
                imdbId,
                season,
                episode,
              }),
              Stream.drain,
            ),
          ),
          Stream.withSpan("Source.Rarbg.Series", {
            attributes: { imdbId, season, episode },
          }),
        ),
      Tv: () => Stream.empty,
    }),
  })
}).pipe(
  Layer.scopedDiscard,
  Layer.provide(Sources.Live),
  Layer.provide(Cinemeta.Live),
)
