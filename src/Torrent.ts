import { HttpClient } from "@effect/platform"
import { Context, Effect, Layer, pipe } from "effect"
import { WebTorrent } from "./WebTorrent.js"

const make = Effect.gen(function* () {
  const webtorrent = yield* WebTorrent
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)

  const fromHashItorrents = (hash: string) =>
    pipe(
      client.get(`https://itorrents.org/torrent/${hash}.torrent`),
      Effect.flatMap(r => r.arrayBuffer),
      Effect.scoped,
      Effect.map(buffer => new Uint8Array(buffer)),
      Effect.withSpan("Torrent.fromHashItorrents", { attributes: { hash } }),
    )

  const fromHashWebtorrent = (hash: string) =>
    pipe(
      webtorrent.getTorrent(hash),
      Effect.map(torrent => new Uint8Array(torrent.torrentFile)),
      Effect.withSpan("Torrent.fromHashWebtorrent", { attributes: { hash } }),
    )

  const fromHash = (hash: string) =>
    fromHashItorrents(hash).pipe(
      Effect.race(fromHashWebtorrent(hash)),
      Effect.withSpan("Torrent.fromHash", { attributes: { hash } }),
    )

  return { fromHash } as const
})

export class Torrent extends Context.Tag("Torrent")<
  Torrent,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.effect(Torrent, make).pipe(Layer.provide(WebTorrent.Live))
}
