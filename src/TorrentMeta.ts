import {
  infoHashFromMagnet,
  magnetFromHash,
  qualityFromTitle,
} from "./Utils.js"
import { SourceStreamWithFile } from "./Domain/SourceStream.js"
import ParseTorrent from "parse-torrent"
import { Effect, Layer, pipe, ServiceMap } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Data } from "effect/data"
import { Cache } from "effect/caching"
import { Schema } from "effect/schema"

export class TorrentMeta extends ServiceMap.Key<TorrentMeta>()("TorrentMeta", {
  make: Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        HttpClientRequest.prependUrl("https://itorrents.org/torrent"),
      ),
      HttpClient.filterStatusOk,
    )

    class HashRequest extends Data.Class<{
      readonly infoHash: string
    }> {
      // [PrimaryKey.symbol]() {
      //   return String(Hash.string(this.infoHash))
      // }
      // get [Schema.symbolWithResult]() {
      //   return {
      //     success: TorrentMetadata,
      //     failure: Schema.Never,
      //   }
      // }
    }

    const fromHashCache = yield* Cache.makeWith({
      // storeId: "TorrentMeta.fromHash",
      lookup: ({ infoHash }: HashRequest) =>
        client.get(`/${infoHash}.torrent`).pipe(
          Effect.flatMap((_) => _.arrayBuffer),
          Effect.flatMap((buffer) =>
            Effect.promise(() => ParseTorrent(new Uint8Array(buffer)) as any),
          ),
          Effect.flatMap(Schema.decodeUnknownEffect(TorrentMetadata)),
          Effect.orDie,
        ),
      timeToLive: (exit) => (exit._tag === "Failure" ? "1 minute" : "3 days"),
      capacity: 512,
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
        Cache.get(fromHashCache, new HashRequest({ infoHash: hash })),
        Effect.timeout(5000),
        Effect.withSpan("TorrentMeta.fromHash", { attributes: { hash } }),
      )

    return { fromMagnet, fromHash, parse } as const
  }),
}) {
  static layer = Layer.effect(this)(this.make)
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
