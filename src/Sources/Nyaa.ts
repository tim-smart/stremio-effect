import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Array, Effect, flow, Layer, Match, pipe, Stream } from "effect"
import * as Cheerio from "cheerio"
import { Sources } from "../Sources.js"
import {
  cacheWithSpan,
  infoHashFromMagnet,
  qualityFromTitle,
} from "../Utils.js"
import { AbsoluteSeriesQuery, VideoQuery } from "../Domain/VideoQuery.js"
import { SourceStream } from "../Domain/SourceStream.js"

export const SourceNyaaLive = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.mapRequest(
      flow(HttpClientRequest.prependUrl("https://nyaa.si")),
    ),
  )

  const searchCache = yield* cacheWithSpan({
    lookup: (request: AbsoluteSeriesQuery) =>
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
        Effect.map(html =>
          pipe(
            parseResults(html),
            Array.map(
              result =>
                new SourceStream({
                  source: "Nyaa",
                  infoHash: infoHashFromMagnet(result.magnet),
                  title: result.title,
                  magnetUri: result.magnet,
                  quality: qualityFromTitle(result.title),
                  seeds: result.seeds,
                  peers: result.peers,
                  sizeDisplay: result.size,
                }),
            ),
          ),
        ),
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

  const sources = yield* Sources
  yield* sources.register({
    list: Match.type<VideoQuery>().pipe(
      Match.tag("AbsoluteSeriesQuery", query =>
        searchCache(query).pipe(
          Effect.tapErrorCause(Effect.logDebug),
          Effect.orElseSucceed(() => []),
          Effect.withSpan("Source.Nyaa.Series", {
            attributes: { query },
          }),
          Effect.annotateLogs({ service: "Source.Nyaa", query }),
          Stream.fromIterableEffect,
        ),
      ),
      Match.orElse(() => Stream.empty),
    ),
  })
}).pipe(Layer.scopedDiscard, Layer.provide(Sources.Live))
