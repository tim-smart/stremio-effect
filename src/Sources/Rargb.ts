import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Cheerio from "cheerio"
import { Effect, Layer, pipe, Schedule } from "effect"
import { SourceSeason, SourceStream } from "../Domain/SourceStream.js"
import { TitleVideoQuery, VideoQuery } from "../Domain/VideoQuery.js"
import { Sources } from "../Sources.js"
import { infoHashFromMagnet, qualityFromTitle } from "../Utils.js"
import { Schema } from "effect/schema"
import { Stream } from "effect/stream"
import { Match } from "effect/match"
import { Cache } from "effect/caching"
import { Data } from "effect/data"

export const SourceRargbLive = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.mapRequest(HttpClientRequest.prependUrl("https://rargb.to")),
    HttpClient.retryTransient({
      times: 5,
      schedule: Schedule.spaced(500),
    }),
  )

  const parseResults = (html: string) => {
    const $ = Cheerio.load(html)
    const table = $("table.lista2t")
    const streams: Array<SearchResult> = []
    table.find("tr.lista2").each((_, row) => {
      const $row = $(row)
      const cells = $row.find("> td")
      const link = cells.eq(1).find("a")
      streams.push(
        new SearchResult({
          url: link.attr("href")!,
          title: link.attr("title")!,
          size: cells.eq(4).text(),
          seeds: +cells.eq(5).text(),
          peers: +cells.eq(6).text(),
        }),
      )
    })
    return streams
  }

  class SearchRequest extends Data.Class<{
    query: string
    category: "movies" | "series"
  }> {
    // [PrimaryKey.symbol]() {
    //   return `${this.category}/${this.query}`
    // }
    // get [Schema.symbolWithResult]() {
    //   return {
    //     success: SearchResult.Array,
    //     failure: Schema.Never,
    //   }
    // }
  }

  const searchCache = yield* Cache.makeWith({
    // storeId: "Source.Rarbg.search",
    lookup: (request: SearchRequest) =>
      pipe(
        client.get("/search/", {
          urlParams: {
            search: request.query,
            "category[]":
              request.category === "movies" ? ["movies"] : ["tv", "anime"],
          },
        }),
        Effect.flatMap((r) => r.text),
        Effect.scoped,
        Effect.map(parseResults),
        Effect.orDie,
        Effect.withSpan("Source.Rarbg.search", { attributes: { ...request } }),
      ),
    timeToLive: (exit) => {
      if (exit._tag === "Failure") return "5 minutes"
      return exit.value.length > 5 ? "3 days" : "3 hours"
    },
    capacity: 128,
  })

  const searchStream = (request: TitleVideoQuery) =>
    pipe(
      Cache.get(
        searchCache,
        new SearchRequest({
          query: request.asQuery,
          category: request._tag === "MovieQuery" ? "movies" : "series",
        }),
      ),
      Stream.fromArrayEffect,
      Stream.take(30),
      Stream.flatMap(
        (result) =>
          Cache.get(
            magnetLink,
            new MagnetLinkRequest({ url: result.url }),
          ).pipe(
            Effect.map((magnet) =>
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
            Stream.fromEffect,
            Stream.ignoreCause,
          ),
        { concurrency: "unbounded" },
      ),
    )

  class MagnetLinkRequest extends Data.Class<{ url: string }> {
    // [PrimaryKey.symbol]() {
    //   return Hash.hash(this).toString()
    // }
    // get [Schema.symbolWithResult]() {
    //   return {
    //     success: Schema.String,
    //     failure: Schema.Never,
    //   }
    // }
  }
  const magnetLink = yield* Cache.makeWith({
    // storeId: "Source.Rarbg.magnetLink",
    lookup: ({ url }: MagnetLinkRequest) =>
      client.get(url).pipe(
        Effect.flatMap((r) => r.text),
        Effect.flatMap((html) => {
          const $ = Cheerio.load(html)
          return Effect.fromNullishOr(
            $("td.lista a[href^='magnet:']").attr("href"),
          )
        }),
        Effect.orDie,
      ),
    timeToLive: (exit) => (exit._tag === "Success" ? "3 weeks" : "5 minutes"),
    capacity: 512,
  })

  const sources = yield* Sources
  yield* sources.register({
    name: "Rarbg",
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
                  service: "Source.Rarbg",
                  method: "list",
                  query,
                }),
                Stream.fromEffect,
                Stream.drain,
              ),
            ),
            Stream.withSpan("Source.Rarbg.list", { attributes: { query } }),
          ),
      ),
      Match.orElse(() => Stream.empty),
    ),
  })
}).pipe(Layer.effectDiscard, Layer.provide(Sources.layer))

class SearchResult extends Schema.Class<SearchResult>("SearchResult")({
  url: Schema.String,
  title: Schema.String,
  size: Schema.String,
  seeds: Schema.Number,
  peers: Schema.Number,
}) {
  static Array = Schema.Array(this)
}
