import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Array, Effect, flow, identity, Layer, pipe } from "effect"
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

  const magnetLink = (url: string) =>
    HttpClientRequest.get(url).pipe(
      client,
      HttpClientResponse.text,
      Effect.flatMap(html => {
        const $ = Cheerio.load(html)
        return Effect.fromNullable(
          $("td.lista a[href^='magnet:']").attr("href"),
        )
      }),
    )

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
        Effect.map(parseResults),
        Effect.andThen(results => {
          const matcher = request.titleMatcher
          return Effect.allSuccesses(
            pipe(
              results,
              matcher._tag === "Some"
                ? Array.filter(_ => matcher.value(_.title))
                : identity,
              Array.map(result =>
                magnetLink(result.url).pipe(
                  Effect.map(magnet => ({ ...result, magnet })),
                ),
              ),
            ),
            { concurrency: 15 },
          )
        }),
        Effect.map(
          Array.map(
            result =>
              new SourceStream({
                source: "Rarbg",
                infoHash: infoHashFromMagnet(result.magnet),
                magnetUri: result.magnet,
                quality: qualityFromTitle(result.title),
                seeds: result.seeds,
                peers: result.peers,
                sizeDisplay: result.size,
              }),
          ),
        ),
        Effect.withSpan("Source.Rarbg.search", { attributes: { ...request } }),
      ),
    capacity: 4096,
    timeToLive: "12 hours",
  })

  const cinemeta = yield* Cinemeta
  const sources = yield* Sources
  yield* sources.register({
    list: StreamRequest.$match({
      Channel: () => Effect.succeed([]),
      Movie: ({ imdbId }) =>
        pipe(
          cinemeta.lookupMovie(imdbId),
          Effect.andThen(result => searchCache(result.query)),
          Effect.tapErrorCause(Effect.logDebug),
          Effect.orElseSucceed(() => [] as SourceStream[]),
          Effect.withSpan("Source.Rarbg.Movie", { attributes: { imdbId } }),
          Effect.annotateLogs({
            service: "Source.Rarbg",
            imdbId,
          }),
        ),
      Series: ({ imdbId, season, episode }) =>
        pipe(
          cinemeta.lookupEpisode(imdbId, season, episode),
          Effect.andThen(result =>
            Effect.forEach(result.queries, searchCache, {
              concurrency: "unbounded",
            }),
          ),
          Effect.map(Array.flatten),
          Effect.tapErrorCause(Effect.logDebug),
          Effect.orElseSucceed(() => [] as SourceStream[]),
          Effect.withSpan("Source.Rarbg.Series", {
            attributes: { imdbId, season, episode },
          }),
          Effect.annotateLogs({
            service: "Source.Rarbg",
            imdbId,
            season,
            episode,
          }),
        ),
      Tv: () => Effect.succeed([]),
    }),
  })
}).pipe(
  Layer.scopedDiscard,
  Layer.provide(Sources.Live),
  Layer.provide(Cinemeta.Live),
)
