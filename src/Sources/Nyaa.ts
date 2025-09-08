import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Cheerio from "cheerio"
import { Effect, Layer, pipe, Schedule } from "effect"
import { SourceStream } from "../Domain/SourceStream.js"
import { AbsoluteSeriesQuery, VideoQuery } from "../Domain/VideoQuery.js"
import { Sources } from "../Sources.js"
import { infoHashFromMagnet, qualityFromTitle } from "../Utils.js"
import { Array } from "effect/collections"
import { Match } from "effect/match"
import { Stream } from "effect/stream"
import { PersistenceLayer } from "../Persistence.js"

export const SourceNyaaLive = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.mapRequest(HttpClientRequest.prependUrl("https://nyaa.si")),
    HttpClient.retryTransient({
      times: 5,
      schedule: Schedule.exponential(100),
    }),
  )

  const search = (request: AbsoluteSeriesQuery) =>
    pipe(
      client.get("/", {
        urlParams: {
          f: 1,
          c: "1_2",
          s: "seeders",
          o: "desc",
          q: request.asQuery,
        },
      }),
      Effect.flatMap((r) => r.text),
      Effect.map((html) =>
        pipe(
          parseResults(html),
          Array.map(
            (result) =>
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
      Effect.orDie,
      Effect.withSpan("Source.Nyaa.search", { attributes: { ...request } }),
    )

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
    name: "Nyaa",
    list: Match.type<VideoQuery>().pipe(
      Match.tag("AbsoluteSeriesQuery", (query) =>
        search(query).pipe(
          Effect.tapCause(Effect.logDebug),
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
}).pipe(Layer.effectDiscard, Layer.provide([Sources.layer, PersistenceLayer]))
