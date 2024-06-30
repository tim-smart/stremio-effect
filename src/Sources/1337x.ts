import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Data, Duration, Effect, flow, Layer, Match, Stream } from "effect"
import * as Cheerio from "cheerio"
import { Sources } from "../Sources.js"
import {
  cacheWithSpan,
  infoHashFromMagnet,
  qualityFromTitle,
} from "../Utils.js"
import { TitleVideoQuery, VideoQuery } from "../Domain/VideoQuery.js"
import { SourceSeason, SourceStream } from "../Domain/SourceStream.js"

export const Source1337xLive = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.mapRequest(
      flow(HttpClientRequest.prependUrl("https://1337x.to")),
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
            $("div.torrent-detail-page a[href^='magnet:']").attr("href"),
          )
        }),
      ),
    capacity: 4096,
    timeToLive: Duration.infinity,
  })

  const parseResults = (html: string) => {
    const $ = Cheerio.load(html)
    const table = $("table.table-list")
    const streams: Array<{
      readonly url: string
      readonly title: string
      readonly size: string
      readonly seeds: number
      readonly peers: number
    }> = []
    table.find("> tbody > tr").each((_, row) => {
      const $row = $(row)
      const cells = $row.find("> td")
      const link = cells.eq(0).find("a").eq(1)
      streams.push({
        url: link.attr("href")!,
        title: link.text().trim(),
        size: cells
          .eq(4)[0]
          .children.filter(_ => _.type === "text")
          .map(_ => _.data)
          .join(" ")
          .trim(),
        seeds: +cells.eq(1).text(),
        peers: +cells.eq(2).text(),
      })
    })
    return streams
  }

  class SearchRequest extends Data.Class<{
    query: string
    category: "Movies" | "TV"
  }> {}

  const searchCache = yield* cacheWithSpan({
    lookup: (request: SearchRequest) =>
      HttpClientRequest.get(
        `/sort-category-search/${encodeURIComponent(request.query)}/${request.category}/seeders/desc/1/`,
      ).pipe(
        client,
        HttpClientResponse.text,
        Effect.map(parseResults),
        Effect.withSpan("Source.1337x.search", { attributes: { ...request } }),
      ),
    capacity: 4096,
    timeToLive: "12 hours",
  })

  const searchStream = (request: TitleVideoQuery) =>
    searchCache(
      new SearchRequest({
        query: request.asQuery,
        category: request._tag === "MovieQuery" ? "Movies" : "TV",
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
                    source: "1337x",
                    title: result.title,
                    infoHash: infoHashFromMagnet(magnet),
                    magnetUri: magnet,
                    seeds: result.seeds,
                    peers: result.peers,
                  })
                : new SourceStream({
                    source: "1337x",
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
                  service: "Source.1337x",
                  method: "list",
                  query,
                }),
                Stream.drain,
              ),
            ),
            Stream.withSpan("Source.1337x.list", { attributes: { query } }),
          ),
      ),
      Match.orElse(() => Stream.empty),
    ),
  })
}).pipe(Layer.scopedDiscard, Layer.provide(Sources.Live))
