import {
  infoHashFromMagnet,
  magnetFromHash,
  qualityFromTitle,
} from "./Utils.js"
import { SourceStreamWithFile } from "./Domain/SourceStream.js"
import ParseTorrent from "parse-torrent"
import { Effect, Layer, pipe, ServiceMap } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Schema } from "effect/schema"
import { Persistable, PersistedCache } from "effect/unstable/persistence"
import { PersistenceLayer } from "./Persistence.js"

export class TorrentMeta extends ServiceMap.Service<TorrentMeta>()("TorrentMeta", {
  make: Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        HttpClientRequest.prependUrl("https://itorrents.org/torrent"),
      ),
      HttpClient.filterStatusOk,
    )

    class TorrentLookup extends Persistable.Class<{
      payload: { infoHash: string }
    }>()("TorrentMeta.TorrentLookup", {
      primaryKey: (_) => _.infoHash,
      success: TorrentMetadata,
    }) {}

    const fromHashCache = yield* PersistedCache.make({
      storeId: "TorrentMeta.fromHash",
      lookup: ({ infoHash }: TorrentLookup) =>
        client.get(`/${infoHash}.torrent`).pipe(
          Effect.flatMap((_) => _.arrayBuffer),
          Effect.flatMap((buffer) =>
            Effect.promise(() => ParseTorrent(new Uint8Array(buffer)) as any),
          ),
          Effect.flatMap(Schema.decodeUnknownEffect(TorrentMetadata)),
          Effect.orDie,
        ),
      timeToLive: (exit) => (exit._tag === "Failure" ? "1 minute" : "3 days"),
      inMemoryCapacity: 16,
    })

    const parse = (buffer: ArrayBuffer) =>
      Effect.promise(() => ParseTorrent(new Uint8Array(buffer)) as any).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(TorrentMetadata)),
        Effect.orDie,
      )

    const fromMagnet = (magnet: string) =>
      fromHash(infoHashFromMagnet(magnet)).pipe(
        Effect.withSpan("TorrentMeta.fromMagnet", { attributes: { magnet } }),
      )

    const fromHash = (hash: string) =>
      pipe(
        fromHashCache.get(new TorrentLookup({ infoHash: hash })),
        Effect.timeout(5000),
        Effect.withSpan("TorrentMeta.fromHash", { attributes: { hash } }),
      )

    return { fromMagnet, fromHash, parse } as const
  }),
}) {
  static layer = Layer.effect(this)(this.make).pipe(
    Layer.provide(PersistenceLayer),
  )
}

export class TorrentFile extends Schema.Class<TorrentFile>("TorrentFile")({
  name: Schema.String,
  length: Schema.Number,
  path: Schema.String,
}) {}

export class TorrentMetadata extends Schema.Class<TorrentMetadata>(
  "TorrentMeta/TorrentMetadata",
)({
  name: Schema.String,
  infoHash: Schema.String,
  files: Schema.NonEmptyArray(TorrentFile),
}) {
  streams(options: {
    readonly source: string
    readonly seeds: number
    readonly peers: number
  }): Array<SourceStreamWithFile> {
    return this.files
      .filter((_) => /\.(mp4|mkv|avi)$/.test(_.name))
      .map(
        (file, index) =>
          new SourceStreamWithFile({
            source: options.source,
            title: file.name,
            infoHash: this.infoHash,
            magnetUri: magnetFromHash(this.infoHash),
            quality: qualityFromTitle(file.name),
            seeds: options.seeds,
            peers: options.peers,
            sizeBytes: file.length,
            fileNumber: index,
          }),
      )
  }
}