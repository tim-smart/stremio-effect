import Api from "webtorrent"
import { Context, Effect, Layer, RcRef } from "effect"
import { cacheWithSpan, magnetFromHash } from "./Utils.js"

const make = Effect.gen(function* () {
  const client = yield* RcRef.make({
    acquire: Effect.acquireRelease(
      Effect.sync(() => new Api()),
      client =>
        Effect.async<void>(resume => {
          return client.destroy(() => resume(Effect.void))
        }),
    ),
    idleTimeToLive: "5 minutes",
  })

  const getTorrentCache = yield* cacheWithSpan({
    lookup: (hash: string) =>
      client.pipe(
        Effect.flatMap(client =>
          Effect.async<Api.Torrent>(resume => {
            const magnet = magnetFromHash(hash)
            const torrent = client.add(magnet, torrent => {
              client.remove(torrent)
              return resume(Effect.succeed(torrent))
            })
            return Effect.sync(() => {
              client.remove(torrent)
            })
          }),
        ),
        Effect.scoped,
      ),
    capacity: 8,
    timeToLive: "5 minutes",
  })

  const getTorrent = (hash: string) =>
    getTorrentCache(hash.toLowerCase()).pipe(
      Effect.withSpan("WebTorrent.getTorrent", { attributes: { hash } }),
    )

  return { getTorrent } as const
})

export class WebTorrent extends Context.Tag("WebTorrent")<
  WebTorrent,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.scoped(WebTorrent, make)
}
