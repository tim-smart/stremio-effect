import { PersistedCache } from "@effect/experimental"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import * as Cheerio from "cheerio"
import {
  Data,
  Effect,
  Hash,
  Layer,
  Match,
  pipe,
  PrimaryKey,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { SourceSeason, SourceStream } from "../Domain/SourceStream.js"
import { TitleVideoQuery, VideoQuery } from "../Domain/VideoQuery.js"
import { PersistenceLive } from "../Persistence.js"
import { Sources } from "../Sources.js"
import { infoHashFromMagnet, qualityFromTitle } from "../Utils.js"

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

  class SearchRequest extends Data.Class<{
    query: string
    category: "Movies" | "TV"
  }> {
    [PrimaryKey.symbol]() {
      return `${this.category}/${this.query}`
    }
    get [Schema.symbolWithResult]() {
      return {
        success: SearchResult.Array,
        failure: Schema.Never,
      }
    }
  }

  const searchCache = yield* PersistedCache.make({
    storeId: "Source.1337x.search",
    lookup: (request: SearchRequest) =>
      pipe(
        client.get(
          `/sort-category-search/${encodeURIComponent(request.query)}/${request.category}/seeders/desc/1/`,
        ),
        Effect.flatMap((r) => r.text),
        Effect.scoped,
        Effect.map(parseResults),
        Effect.orDie,
        Effect.withSpan("Source.1337x.search", {
          attributes: { ...request },
        }),
      ),
    timeToLive: (_, exit) => {
      if (exit._tag === "Failure") return "1 minute"
      return exit.value.length > 5 ? "3 days" : "3 hours"
    },
    inMemoryCapacity: 8,
  })

  const searchStream = (request: TitleVideoQuery) =>
    pipe(
      searchCache.get(
        new SearchRequest({
          query: request.asQuery,
          category: request._tag === "MovieQuery" ? "Movies" : "TV",
        }),
      ),
      Effect.map(Stream.fromIterable),
      Stream.unwrap,
      Stream.take(30),
      Stream.flatMap(
        (result) =>
          magnetLink.get(new MagnetLinkRequest({ url: result.url })).pipe(
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
            Stream.catchAllCause(() => Stream.empty),
          ),
        { concurrency: "unbounded" },
      ),
    )

  class MagnetLinkRequest extends Data.Class<{ url: string }> {
    [PrimaryKey.symbol]() {
      return Hash.hash(this).toString()
    }
    get [Schema.symbolWithResult]() {
      return {
        success: Schema.String,
        failure: Schema.Never,
      }
    }
  }
  const magnetLink = yield* PersistedCache.make({
    storeId: "Source.1337x.magnetLink",
    lookup: ({ url }: MagnetLinkRequest) =>
      client.get(url).pipe(
        Effect.flatMap((r) => r.text),
        Effect.scoped,
        Effect.flatMap((html) => {
          const $ = Cheerio.load(html)
          return Effect.fromNullable(
            $("div.torrent-detail-page a[href^='magnet:']").attr("href"),
          )
        }),
        Effect.orDie,
      ),
    timeToLive: (_, exit) =>
      exit._tag === "Success" ? "3 weeks" : "5 minutes",
    inMemoryCapacity: 8,
  })

  const sources = yield* Sources
  yield* sources.register({
    list: Match.type<VideoQuery>().pipe(
      Match.tag(
        "AbsoluteSeriesQuery",
        "MovieQuery",
        "SeriesQuery",
        "SeasonQuery",
        (query) =>
          searchStream(query).pipe(
            Stream.catchAllCause((cause) =>
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
}).pipe(Layer.scopedDiscard, Layer.provide([Sources.Default, PersistenceLive]))

class SearchResult extends Schema.Class<SearchResult>("SearchResult")({
  url: Schema.String,
  title: Schema.String,
  size: Schema.String,
  seeds: Schema.Number,
  peers: Schema.Number,
}) {
  static Array = Schema.Array(this)
}
