import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import {
  Data,
  Duration,
  Effect,
  flow,
  Layer,
  Match,
  Schedule,
  Stream,
} from "effect"
import * as Cheerio from "cheerio"
import { Sources } from "../Sources.js"
import {
  cacheWithSpan,
  infoHashFromMagnet,
  qualityFromTitle,
} from "../Utils.js"
import { TitleVideoQuery, VideoQuery } from "../Domain/VideoQuery.js"
import { SourceSeason, SourceStream } from "../Domain/SourceStream.js"

export const SourceRargbLive = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.mapRequest(
      flow(HttpClientRequest.prependUrl("https://rargb.to")),
    ),
    HttpClient.transformResponse(
      Effect.retry({
        while: err =>
          err._tag === "ResponseError" && err.response.status === 429,
        times: 5,
        schedule: Schedule.spaced(5000),
      }),
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

  class SearchRequest extends Data.Class<{
    query: string
    category: "movies" | "series"
  }> {}

  const searchCache = yield* cacheWithSpan({
    lookup: (request: SearchRequest) =>
      HttpClientRequest.get("/search/").pipe(
        HttpClientRequest.setUrlParams({
          search: request.query,
          "category[]":
            request.category === "movies" ? ["movies"] : ["tv", "anime"],
        }),
        client,
        HttpClientResponse.text,
        Effect.map(parseResults),
        Effect.withSpan("Source.Rarbg.search", { attributes: { ...request } }),
      ),
    capacity: 4096,
    timeToLive: "12 hours",
  })

  const searchStream = (request: TitleVideoQuery) =>
    searchCache(
      new SearchRequest({
        query: request.asQuery,
        category: request._tag === "MovieQuery" ? "movies" : "series",
      }),
    ).pipe(
      Effect.map(Stream.fromIterable),
      Stream.unwrap,
      Stream.take(10),
      Stream.flatMap(
        result =>
          magnetLink(result.url).pipe(
            Effect.map(magnet =>
              request._tag === "SeasonQuery"
                ? new SourceSeason({
                    source: "Rarbg",
                    title: result.title,
                    infoHash: infoHashFromMagnet(magnet),
                    magnetUri: magnet,
                    seeds: result.seeds,
                    peers: result.peers,
                  })
                : new SourceStream({
                    source: "Rarbg",
                    title: result.title,
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

  const sources = yield* Sources
  yield* sources.register({
    list: Match.type<VideoQuery>().pipe(
      Match.tag(
        "AbsoluteSeriesQuery",
        "MovieQuery",
        "SeriesQuery",
        "SeasonQuery",
        query =>
          searchStream(query).pipe(
            Stream.catchAllCause(cause =>
              Effect.logDebug(cause).pipe(
                Effect.annotateLogs({
                  service: "Source.Rarbg",
                  method: "list",
                  query,
                }),
                Stream.drain,
              ),
            ),
            Stream.withSpan("Source.Rarbg.list", { attributes: { query } }),
          ),
      ),
      Match.orElse(() => Stream.empty),
    ),
  })
}).pipe(Layer.scopedDiscard, Layer.provide(Sources.Live))
