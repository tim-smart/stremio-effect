import {
  NodeHttpClient,
  NodeHttpServer,
  NodeRuntime,
} from "@effect/platform-node"
import { createServer } from "node:http"
import * as Net from "node:net"
import { AddonLive } from "./Addon.js"
import { Config, Layer } from "effect"
import { MinimumLogLevel } from "effect/References"
import { TracingLayer } from "./Tracing.js"

// Fixes issues with timeouts
Net.setDefaultAutoSelectFamily(false)

const MainLive = AddonLive.pipe(
  Layer.provide([
    NodeHttpServer.layerConfig(createServer, {
      port: Config.port("PORT").pipe(Config.withDefault(() => 8000)),
    }),
    NodeHttpClient.layerUndici,
  ]),
  Layer.provide(TracingLayer),
  Layer.provide(Layer.succeed(MinimumLogLevel)("All")),
)

NodeRuntime.runMain(Layer.launch(MainLive))
