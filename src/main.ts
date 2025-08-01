import {
  NodeHttpClient,
  NodeHttpServer,
  NodeRuntime,
} from "@effect/platform-node"
import { Layer } from "effect"
import { TracingLayer } from "./Tracing.js"
import { createServer } from "node:http"
import * as Net from "node:net"
import { AddonLive } from "./Addon.js"
import { Config } from "effect/config"
import { MinimumLogLevel } from "effect/References"

// Fixes issues with timeouts
Net.setDefaultAutoSelectFamily(false)

const MainLive = AddonLive.pipe(
  Layer.provide([
    NodeHttpServer.layerConfig(createServer, {
      port: Config.Port("PORT").pipe(Config.withDefault(8000)),
    }),
    NodeHttpClient.layerUndici,
  ]),
  Layer.provide(TracingLayer),
  Layer.provide(Layer.succeed(MinimumLogLevel)("All")),
)

NodeRuntime.runMain(Layer.launch(MainLive))
