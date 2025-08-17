import {
  NodeHttpClient,
  NodeHttpServer,
  NodeRuntime,
} from "@effect/platform-node"
import { Layer } from "effect"
import { createServer } from "node:http"
import * as Net from "node:net"
import { AddonLive } from "./Addon.js"
import { Config } from "effect/config"
import { MinimumLogLevel } from "effect/References"
import { Schema } from "effect/schema"

// Fixes issues with timeouts
Net.setDefaultAutoSelectFamily(false)

const MainLive = AddonLive.pipe(
  Layer.provide([
    NodeHttpServer.layerConfig(createServer, {
      port: Config.schema(
        Config.Port.pipe(Schema.withDecodingDefault(() => 8000)),
        "PORT",
      ),
    }),
    NodeHttpClient.layerUndici,
  ]),
  // Layer.provide(TracingLayer),
  Layer.provide(Layer.succeed(MinimumLogLevel)("All")),
)

NodeRuntime.runMain(Layer.launch(MainLive))
