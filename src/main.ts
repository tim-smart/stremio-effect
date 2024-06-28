import {
  NodeHttpClient,
  NodeHttpServer,
  NodeRuntime,
} from "@effect/platform-node"
import * as Stremio from "./Stremio.js"
import { Config, Layer, Logger, LogLevel } from "effect"
import { TracingLive } from "./Tracing.js"
import { AllSourcesDebrid } from "./Sources/All.js"
import { createServer } from "node:http"
import * as Net from "node:net"

// Fixes issues with timeouts
Net.setDefaultAutoSelectFamily(false)

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
    NodeHttpServer.layerConfig(createServer, {
      port: Config.integer("PORT").pipe(Config.withDefault(8000)),
    }),
  ),
  Layer.provide(AllSourcesDebrid),
  Layer.provide(NodeHttpClient.layerUndici),
)

const MainLive = StremioLive.pipe(
  Layer.provide(TracingLive),
  Layer.provide(Logger.minimumLogLevel(LogLevel.All)),
)

NodeRuntime.runMain(Layer.launch(MainLive))
