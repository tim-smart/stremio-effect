import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Array, Effect, flow, identity, Layer, pipe } from "effect"
import * as Cheerio from "cheerio"
import { Sources, SourceStream } from "../Sources.js"
import {
  cacheWithSpan,
  infoHashFromMagnet,
  qualityFromTitle,
} from "../Utils.js"
import { StreamRequest } from "../Stremio.js"
import { Cinemeta } from "../Cinemeta.js"
import { SeriesQuery } from "../Domain/VideoQuery.js"

export const SourceNyaaLive = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.mapRequest(
      flow(HttpClientRequest.prependUrl("https://nyaa.si")),
    ),
  )

  const searchCache = yield* cacheWithSpan({
    lookup: (request: SeriesQuery) =>
      HttpClientRequest.get("/").pipe(
        HttpClientRequest.setUrlParams({
          f: 1,
          c: "1_2",
          s: "seeders",
          o: "desc",
          q: request.asQuery,
        }),
        client,
        HttpClientResponse.text,
        Effect.map(html => {
          const matcher = request.titleMatcher
          return pipe(
            parseResults(html),
            matcher._tag === "Some"
              ? Array.filter(_ => matcher.value(_.title))
              : identity,
            Array.map(
              result =>
                new SourceStream({
                  source: "Nyaa",
                  infoHash: infoHashFromMagnet(result.magnet),
                  magnetUri: result.magnet,
                  quality: qualityFromTitle(result.title),
                  seeds: result.seeds,
                  peers: result.peers,
                  sizeDisplay: result.size,
                }),
            ),
          )
        }),
        Effect.withSpan("Source.Nyaa.search", { attributes: { ...request } }),
      ),
    capacity: 4096,
    timeToLive: "12 hours",
  })

  const parseResults = (html: string) => {
    const $ = Cheerio.load(html)
    const table = $("table.torrent-list")
    const streams: Array<{
      readonly title: string
      readonly size: string
      readonly seeds: number
      readonly peers: number
      readonly magnet: string
    }> = []
    table.find("> tbody > tr").each((_, row) => {
      const $row = $(row)
      const cells = $row.find("> td")
      streams.push({
        title: cells.eq(1).text().trim(),
        size: cells.eq(3).text(),
        seeds: +cells.eq(5).text(),
        peers: +cells.eq(6).text(),
        magnet: cells.eq(2).find("a[href^='magnet:']").attr("href")!,
      })
    })
    return streams
  }

  const cinemeta = yield* Cinemeta
  const sources = yield* Sources
  yield* sources.register({
    list: StreamRequest.$match({
      Channel: () => Effect.succeed([]),
      Movie: () => Effect.succeed([]),
      Series: ({ imdbId, season, episode }) =>
        pipe(
          cinemeta.lookupEpisode(imdbId, season, episode),
          Effect.andThen(result => {
            if (result._tag === "GeneralEpisodeResult") {
              return Effect.succeed([])
            }
            return searchCache(result.absoluteQuery)
          }),
          Effect.tapErrorCause(Effect.logDebug),
          Effect.orElseSucceed(() => []),
          Effect.withSpan("Source.Nyaa.Series", {
            attributes: { imdbId, season, episode },
          }),
          Effect.annotateLogs({
            service: "Source.Nyaa",
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
