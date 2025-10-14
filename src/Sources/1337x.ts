import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Cheerio from "cheerio"
import { Effect, Layer, Match, pipe, Schedule } from "effect"
import { SourceSeason, SourceStream } from "../Domain/SourceStream.js"
import { TitleVideoQuery, VideoQuery } from "../Domain/VideoQuery.js"
import { Sources } from "../Sources.js"
import { infoHashFromMagnet, qualityFromTitle } from "../Utils.js"
import { Schema } from "effect/schema"
import { Stream } from "effect/stream"
import { Persistable, PersistedCache } from "effect/unstable/persistence"
import { PersistenceLayer } from "../Persistence.js"

export const Source1337xLive = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.mapRequest(HttpClientRequest.prependUrl("https://1337x.to")),
    HttpClient.retryTransient({
      times: 5,
      schedule: Schedule.spaced(5000),
    }),
  )

  const parseResults = (html: string) => {
    const $ = Cheerio.load(html)
    const table = $("table.table-list")
    const streams: Array<SearchResult> = []
    table.find("> tbody > tr").each((_, row) => {
      const $row = $(row)
      const cells = $row.find("> td")
      const link = cells.eq(0).find("a").eq(1)
      streams.push(
        new SearchResult({
          url: link.attr("href")!,
          title: link.text().trim(),
          size: cells
            .eq(4)[0]
            .children.filter((_) => _.type === "text")
            .map((_) => _.data)
            .join(" ")
            .trim(),
          seeds: +cells.eq(1).text(),
          peers: +cells.eq(2).text(),
        }),
      )
    })
    return streams
  }

  class SearchRequest extends Persistable.Class<{
    payload: {
      query: string
      category: "Movies" | "TV"
    }
  }>()("1337x.SearchRequest", {
    primaryKey: ({ category, query }) => `${category}-${query}`,
    success: SearchResult.Array,
  }) {}

  const search = yield* PersistedCache.make({
    storeId: "1337x.search",
    lookup: ({ query, category }: SearchRequest) =>
      pipe(
        client.get(
          `/sort-category-search/${encodeURIComponent(query)}/${category}/seeders/desc/1/`,
        ),
        Effect.flatMap((r) => r.text),
        Effect.map(parseResults),
        Effect.orDie,
        Effect.withSpan("Source.1337x.search", {
          attributes: { query, category },
        }),
      ),
    timeToLive: (exit) => {
      if (exit._tag === "Failure") return "1 minute"
      return exit.value.length > 5 ? "3 days" : "3 hours"
    },
    inMemoryCapacity: 8,
  })

  const searchStream = (request: TitleVideoQuery) =>
    pipe(
      search.get(
        new SearchRequest({
          query: request.asQuery,
          category: request._tag === "MovieQuery" ? "Movies" : "TV",
        }),
      ),
      Stream.fromIterableEffect,
      Stream.take(30),
      Stream.flatMap(
        (result) =>
          magnetLink(result.url).pipe(
            Effect.map((magnet) =>
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
            Effect.withSpan("Source.1337x.magnetLink", {
              attributes: { url: result.url, title: result.title },
            }),
            Stream.fromEffect,
            Stream.ignoreCause,
          ),
        { concurrency: "unbounded" },
      ),
    )

  const magnetLink = (url: string) =>
    client.get(url).pipe(
      Effect.flatMap((r) => r.text),
      Effect.flatMap((html) => {
        const $ = Cheerio.load(html)
        return Effect.fromNullishOr(
          $("div.torrent-detail-page a[href^='magnet:']").attr("href"),
        )
      }),
    )

  const sources = yield* Sources
  yield* sources.register({
    name: "1337x",
    list: Match.type<VideoQuery>().pipe(
      Match.tag(
        "AbsoluteSeriesQuery",
        "MovieQuery",
        "SeriesQuery",
        "SeasonQuery",
        (query) =>
          searchStream(query).pipe(
            Stream.catchCause((cause) =>
              Effect.logDebug(cause).pipe(
                Effect.annotateLogs({
                  service: "Source.1337x",
                  method: "list",
                  query,
                }),
                Stream.fromEffectDrain,
              ),
            ),
            Stream.withSpan("Source.1337x.list", { attributes: { query } }),
          ),
      ),
      Match.orElse(() => Stream.empty),
    ),
  })
}).pipe(Layer.effectDiscard, Layer.provide([Sources.layer, PersistenceLayer]))

class SearchResult extends Schema.Class<SearchResult>("SearchResult")({
  url: Schema.String,
  title: Schema.String,
  size: Schema.String,
  seeds: Schema.Number,
  peers: Schema.Number,
}) {
  static Array = Schema.Array(this)
}
