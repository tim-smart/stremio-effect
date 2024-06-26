import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import {
  Array,
  Data,
  Effect,
  flow,
  identity,
  Layer,
  Option,
  pipe,
} from "effect"
import * as Cheerio from "cheerio"
import { Sources, SourceStream } from "../Sources.js"
import {
  cacheWithSpan,
  formatEpisode,
  infoHashFromMagnet,
  qualityFromTitle,
} from "../Utils.js"
import { StreamRequest } from "../Stremio.js"
import { Cinemeta } from "../Cinemeta.js"

type Category = "tv" | "anime" | "movies"

export const SourceRargbLive = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.mapRequest(
      flow(HttpClientRequest.prependUrl("https://rargb.to")),
    ),
  )

  const magnetLink = (url: string) =>
    HttpClientRequest.get(url).pipe(
      client,
      HttpClientResponse.text,
      Effect.flatMap(html => {
        const $ = Cheerio.load(html)
        return Effect.fromNullable(
          $("td.lista a[href^='magnet:']").attr("href"),
        )
      }),
    )

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
    readonly query: string
    readonly episodeQuery?: string
    readonly categories: ReadonlyArray<Category>
  }> {}

  const searchCache = yield* cacheWithSpan({
    lookup: (request: SearchRequest) =>
      HttpClientRequest.get("/search/").pipe(
        HttpClientRequest.setUrlParams({
          search: request.query,
          "category[]": request.categories,
        }),
        client,
        HttpClientResponse.text,
        Effect.map(parseResults),
        Effect.andThen(results =>
          Effect.allSuccesses(
            pipe(
              results,
              request.episodeQuery
                ? Array.filter(
                    _ => !_.title.includes(`${request.episodeQuery}-`),
                  )
                : identity,
              Array.map(result =>
                magnetLink(result.url).pipe(
                  Effect.map(magnet => ({ ...result, magnet })),
                ),
              ),
            ),
            { concurrency: 15 },
          ),
        ),
        Effect.map(
          Array.map(
            result =>
              new SourceStream({
                source: "Rarbg",
                infoHash: infoHashFromMagnet(result.magnet),
                magnetUri: result.magnet,
                quality: qualityFromTitle(result.title),
                seeds: result.seeds,
                peers: result.peers,
                sizeDisplay: result.size,
              }),
          ),
        ),
        Effect.withSpan("Source.Rarbg.search", { attributes: { ...request } }),
      ),
    capacity: 4096,
    timeToLive: "12 hours",
  })

  const cinemeta = yield* Cinemeta
  const sources = yield* Sources
  yield* sources.register({
    list: StreamRequest.$match({
      Channel: () => Effect.succeed([]),
      Movie: ({ imdbId }) =>
        pipe(
          cinemeta.lookupMovie(imdbId),
          Effect.andThen(result =>
            searchCache(
              new SearchRequest({
                query: result.name,
                categories: ["movies"],
              }),
            ),
          ),
          Effect.tapErrorCause(Effect.logDebug),
          Effect.orElseSucceed(() => [] as SourceStream[]),
          Effect.withSpan("Source.Rarbg.Movie", { attributes: { imdbId } }),
          Effect.annotateLogs({
            service: "Source.Rarbg",
            imdbId,
          }),
        ),
      Series: ({ imdbId, season, episode }) =>
        pipe(
          cinemeta.lookupEpisode(imdbId, season, episode),
          Effect.andThen(result =>
            Effect.forEach(
              Option.match(result.episode, {
                onNone: () => result.series.queries(season, episode),
                onSome: _ => _.queries(result.series.name),
              }),
              query =>
                searchCache(
                  new SearchRequest({
                    query,
                    episodeQuery: formatEpisode(season, episode),
                    categories: ["tv", "anime"],
                  }),
                ),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.map(Array.flatten),
          Effect.tapErrorCause(Effect.logDebug),
          Effect.orElseSucceed(() => [] as SourceStream[]),
          Effect.withSpan("Source.Rarbg.Series", {
            attributes: { imdbId, season, episode },
          }),
          Effect.annotateLogs({
            service: "Source.Rarbg",
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
