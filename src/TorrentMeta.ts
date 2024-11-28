import { HttpClient, HttpClientRequest } from "@effect/platform"
import { Data, Effect, Hash, Option, pipe, PrimaryKey, Schema } from "effect"
import { infoHashFromMagnet, qualityFromTitle } from "./Utils.js"
import { PersistedCache } from "@effect/experimental"
import { PersistenceLive } from "./Persistence.js"
import {
  SourceSeason,
  SourceStream,
  SourceStreamWithFile,
} from "./Domain/SourceStream.js"
import ParseTorrent from "parse-torrent"

export class TorrentMeta extends Effect.Service<TorrentMeta>()("TorrentMeta", {
  scoped: Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        HttpClientRequest.prependUrl("https://itorrents.org/torrent"),
      ),
      HttpClient.filterStatusOk,
    )

    class HashRequest extends Data.Class<{
      readonly infoHash: string
    }> {
      [PrimaryKey.symbol]() {
        return String(Hash.string(this.infoHash))
      }
      get [Schema.symbolWithResult]() {
        return {
          success: TorrentMetadata,
          failure: Schema.Never,
        }
      }
    }

    const fromHashCache = yield* PersistedCache.make({
      storeId: "TorrentMeta.fromHash",
      lookup: ({ infoHash }: HashRequest) =>
        pipe(
          client.get(`/${infoHash}.torrent`),
          Effect.flatMap(_ => _.arrayBuffer),
          Effect.scoped,
          Effect.flatMap(buffer =>
            Effect.promise(() => ParseTorrent(new Uint8Array(buffer)) as any),
          ),
          Effect.flatMap(Schema.decodeUnknown(TorrentMetadata)),
          Effect.orDie,
        ),
      timeToLive: (_, exit) =>
        exit._tag === "Failure" ? "1 minute" : "3 days",
      inMemoryCapacity: 8,
    })

    const fromMagnet = (magnet: string) =>
      pipe(
        fromHash(infoHashFromMagnet(magnet)),
        Effect.withSpan("TorrentMeta.fromMagnet", { attributes: { magnet } }),
      )

    const fromHash = (hash: string) =>
      pipe(
        fromHashCache.get(new HashRequest({ infoHash: hash })),
        Effect.timeout(5000),
        Effect.withUnhandledErrorLogLevel(Option.none()),
        Effect.withSpan("TorrentMeta.fromHash", { attributes: { hash } }),
      )

    return { fromMagnet, fromHash } as const
  }),
  dependencies: [PersistenceLive],
}) {}

export class TorrentFile extends Schema.Class<TorrentFile>("TorrentFile")({
  name: Schema.String,
  length: Schema.Number,
  path: Schema.String,
}) {}

export class TorrentMetadata extends Schema.Class<TorrentMetadata>(
  "TorrentMeta/TorrentMetadata",
)({
  files: Schema.NonEmptyArray(TorrentFile),
}) {
  streams(season: SourceSeason | SourceStream): Array<SourceStreamWithFile> {
    return this.files
      .filter(_ => /\.(mp4|mkv|avi)$/.test(_.name))
      .map(
        (file, index) =>
          new SourceStreamWithFile({
            source: season.source,
            title: file.name,
            infoHash: season.infoHash,
            magnetUri: season.magnetUri,
            quality: qualityFromTitle(file.name),
            seeds: season.seeds,
            peers: season.peers,
            sizeBytes: file.length,
            fileNumber: index,
          }),
      )
  }
}
