import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import * as Stremio from "./Stremio.js"
import { Config, Layer, Logger, LogLevel } from "effect"
import { TracingLive } from "./Tracing.js"
import { AllSourcesDebrid } from "./Sources/All.js"
import { PersistenceLive } from "./Persistence.js"
import { HttpClient } from "@effect/platform"

const StremioLive = Stremio.layerAddon.pipe(
  Layer.provide(
    Stremio.StremioManifest.layer({
      id: "co.timsmart.stremio.sources",
      name: "Stremio Sources",
      version: "0.0.1",
      description: "Stream results from various sources",
      catalogs: [],
      resources: ["stream"],
      types: ["movie", "tv", "series"],
    }),
  ),
  Layer.provide(
    BunHttpServer.layerConfig({
      port: Config.integer("PORT").pipe(Config.withDefault(8000)),
    }),
  ),
  Layer.provide(AllSourcesDebrid),
  Layer.provide(HttpClient.layer),
  Layer.provide(PersistenceLive),
)

const MainLive = StremioLive.pipe(
  Layer.provide(TracingLive),
  Layer.provide(Logger.pretty),
  Layer.provide(Logger.minimumLogLevel(LogLevel.All)),
)

BunRuntime.runMain(Layer.launch(MainLive))
