import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import * as Stremio from "./Stremio.js"
import { Layer, Logger, LogLevel } from "effect"
import { HttpClient } from "@effect/platform"
import { TracingLive } from "./Tracing.js"
import { AllSourcesDebrid } from "./Sources/All.js"

const HttpLive = Stremio.layerAddon.pipe(
  Layer.provide(
    Stremio.StremioManifest.layer({
      id: "co.timsmart.stremio.sources",
      name: "Tim's Stremio Sources",
      version: "0.0.1",
      description: "Stream results from various sources",
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
