import {
  NodeHttpClient,
  NodeHttpServer,
  NodeRuntime,
} from "@effect/platform-node"
import * as Stremio from "./Stremio.js"
import { Layer, Logger, LogLevel } from "effect"
import { TracingLive } from "./Tracing.js"
import { AllSourcesDebrid } from "./Sources/All.js"
import { createServer } from "node:http"

const StremioLive = Stremio.layerAddon.pipe(
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
  Layer.provide(NodeHttpServer.layer(createServer, { port: 8000 })),
  Layer.provide(AllSourcesDebrid),
  Layer.provide(NodeHttpClient.layerUndici),
)

const MainLive = StremioLive.pipe(
  Layer.provide(TracingLive),
  Layer.provide(Logger.minimumLogLevel(LogLevel.All)),
)

NodeRuntime.runMain(Layer.launch(MainLive))
