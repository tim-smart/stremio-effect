import {
  NodeHttpClient,
  NodeHttpServer,
  NodeRuntime,
} from "@effect/platform-node"
import { Config, Layer, Logger, LogLevel } from "effect"
import { TracingLive } from "./Tracing.js"
import { createServer } from "node:http"
import * as Net from "node:net"
import { AddonLive } from "./Addon.js"

// Fixes issues with timeouts
Net.setDefaultAutoSelectFamily(false)

const MainLive = AddonLive.pipe(
  Layer.provide([
    NodeHttpServer.layerConfig(createServer, {
      port: Config.integer("PORT").pipe(Config.withDefault(8000)),
    }),
    NodeHttpClient.layerUndici,
  ]),
  Layer.provide(TracingLive),
  Layer.provide(Logger.minimumLogLevel(LogLevel.All)),
)

NodeRuntime.runMain(Layer.launch(MainLive))
