import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import * as Stremio from "./Stremio.js"
import { Layer, Logger, LogLevel } from "effect"
import { HttpClient } from "@effect/platform"
import { SourceYtsLive } from "./Sources/Yts.js"
import { RealDebridLive } from "./RealDebrid.js"
import { SourceEztvLive } from "./Sources/Eztv.js"
import { SourceTpbLive } from "./Sources/Tpb.js"
import { SourceRargbLive } from "./Sources/Rargb.js"
import { TracingLive } from "./Tracing.js"

const AllSources = Layer.mergeAll(
  SourceYtsLive,
  SourceEztvLive,
  SourceTpbLive,
  SourceRargbLive,
)

const AllSourcesDebrid = Layer.mergeAll(AllSources, RealDebridLive)

const HttpLive = Stremio.layerAddon.pipe(
  Layer.provide(
    Stremio.StremioManifest.layer({
      id: "co.timsmart.stremio.effect",
      name: "Effect test",
      version: "0.0.1",
      description: "A test addon using Effect",
      catalogs: [],
      resources: ["stream"],
      types: ["movie", "tv", "series"],
    }),
  ),
  Layer.provide(BunHttpServer.layer({ port: 8000 })),
  Layer.provide(AllSourcesDebrid),
  Layer.provide(HttpClient.layer),
)

const MainLive = HttpLive.pipe(
  Layer.provide(TracingLive),
  Layer.provide(Logger.minimumLogLevel(LogLevel.All)),
)

BunRuntime.runMain(Layer.launch(MainLive))
