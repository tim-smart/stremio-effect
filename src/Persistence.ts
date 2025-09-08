import { KeyValueStore, Persistence } from "effect/unstable/persistence"
import { NodePersistence, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Config } from "effect/config"
import { Option } from "effect/data"

export const PersistenceLayer = Layer.unwrap(
  Effect.gen(function* () {
    const redis = yield* Config.all({
      host: Config.string("REDIS_HOST"),
      port: Config.int("REDIS_PORT").pipe(Config.withDefault(() => 6379)),
    }).pipe(Config.option)

    if (Option.isSome(redis)) {
      return NodePersistence.layerRedis({
        host: redis.value.host,
        port: redis.value.port,
      })
    }

    return Persistence.layerKvs.pipe(
      Layer.provide(KeyValueStore.layerFileSystem("data/persistence")),
      Layer.provide(NodeServices.layer),
    )
  }),
)
