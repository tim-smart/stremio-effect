import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Config, Layer, Logger, LogLevel } from "effect"
import { TracingLive } from "./Tracing.js"
import { FetchHttpClient } from "@effect/platform"
import { AddonLive } from "./Addon.js"

const MainLive = AddonLive.pipe(
  Layer.provide(
    BunHttpServer.layerConfig({
      port: Config.integer("PORT").pipe(Config.withDefault(8000)),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(TracingLive),
  Layer.provide(Logger.minimumLogLevel(LogLevel.All)),
)

BunRuntime.runMain(Layer.launch(MainLive))
