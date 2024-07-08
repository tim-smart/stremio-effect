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
import { PersistedCache, TimeToLive } from "@effect/experimental"
import { Schema, Serializable } from "@effect/schema"

export const SourceRargbLive = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.mapRequest(
      flow(HttpClientRequest.prependUrl("https://rargb.to")),
    ),
    HttpClient.transformResponse(
      Effect.retry({
        while: err =>
          err._tag === "ResponseError" && err.response.status >= 429,
        times: 5,
        schedule: Schedule.spaced(5000),
      }),
    ),
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
    storeId: "Source.Rarbg.search",
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
        Effect.orDie,
        Effect.withSpan("Source.Rarbg.search", { attributes: { ...request } }),
      ),
    inMemoryCapacity: 8,
  })

  const searchStream = (request: TitleVideoQuery) =>
    pipe(
      searchCache.get(
        new SearchRequest({
          query: request.asQuery,
          category: request._tag === "MovieQuery" ? "movies" : "series",
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
    storeId: "Source.Rarbg.magnetLink",
    lookup: ({ url }: MagnetLinkRequest) =>
      HttpClientRequest.get(url).pipe(
        client,
        HttpClientResponse.text,
        Effect.flatMap(html => {
          const $ = Cheerio.load(html)
          return Effect.fromNullable(
            $("td.lista a[href^='magnet:']").attr("href"),
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

class SearchResult extends Schema.Class<SearchResult>("SearchResult")({
  url: Schema.String,
  title: Schema.String,
  size: Schema.String,
  seeds: Schema.Number,
  peers: Schema.Number,
}) {
  static Array = Schema.Array(this)
}
