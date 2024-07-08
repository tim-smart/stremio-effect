import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import {
  Data,
  Effect,
  Exit,
  flow,
  Layer,
  Match,
  pipe,
  PrimaryKey,
  Schedule,
  Stream,
} from "effect"
import * as Cheerio from "cheerio"
import { Sources } from "../Sources.js"
import { infoHashFromMagnet, qualityFromTitle } from "../Utils.js"
import { TitleVideoQuery, VideoQuery } from "../Domain/VideoQuery.js"
import { SourceSeason, SourceStream } from "../Domain/SourceStream.js"
import { Schema, Serializable } from "@effect/schema"
import { PersistedCache, TimeToLive } from "@effect/experimental"

export const Source1337xLive = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.mapRequest(
      flow(HttpClientRequest.prependUrl("https://1337x.to")),
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
            .children.filter(_ => _.type === "text")
            .map(_ => _.data)
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
    [TimeToLive.symbol](exit: Exit.Exit<Array<SearchResult>, unknown>) {
      if (exit._tag === "Failure") return "5 minutes"
      return exit.value.length > 5 ? "3 days" : "3 hours"
    }
    get [Serializable.symbolResult]() {
      return {
        Success: SearchResult.Array,
        Failure: Schema.Never,
      }
    }
  }

  const searchCache = yield* PersistedCache.make({
    storeId: "Source.1337x.search",
    lookup: (request: SearchRequest) =>
      HttpClientRequest.get(
        `/sort-category-search/${encodeURIComponent(request.query)}/${request.category}/seeders/desc/1/`,
      ).pipe(
        client,
        HttpClientResponse.text,
        Effect.map(parseResults),
        Effect.orDie,
        Effect.withSpan("Source.1337x.search", { attributes: { ...request } }),
      ),
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
      Stream.take(10),
      Stream.flatMap(
        result =>
          magnetLink.get(new MagnetLinkRequest({ url: result.url })).pipe(
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

  class MagnetLinkRequest extends Data.Class<{ url: string }> {
    get [Serializable.symbolResult]() {
      return {
        Success: Schema.String,
        Failure: Schema.Never,
      }
    }
    [TimeToLive.symbol](exit: Exit.Exit<string, unknown>) {
      return exit._tag === "Success" ? "3 weeks" : "5 minutes"
    }
  }
  const magnetLink = yield* PersistedCache.make({
    storeId: "Source.1337x.magnetLink",
    lookup: ({ url }: MagnetLinkRequest) =>
      HttpClientRequest.get(url).pipe(
        client,
        HttpClientResponse.text,
        Effect.flatMap(html => {
          const $ = Cheerio.load(html)
          return Effect.fromNullable(
            $("div.torrent-detail-page a[href^='magnet:']").attr("href"),
          )
        }),
        Effect.orDie,
      ),
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

class SearchResult extends Schema.Class<SearchResult>("SearchResult")({
  url: Schema.String,
  title: Schema.String,
  size: Schema.String,
  seeds: Schema.Number,
  peers: Schema.Number,
}) {
  static Array = Schema.Array(this)
}
