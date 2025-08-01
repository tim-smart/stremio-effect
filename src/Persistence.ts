// import * as Persistence from "@effect/experimental/Persistence"
// import * as PersistenceRedis from "@effect/experimental/Persistence/Redis"
// import { NodeKeyValueStore } from "@effect/platform-node"
// import { Config, Effect, Layer, Option } from "effect"
//
// export const PersistenceLive = Layer.unwrapEffect(
//   Effect.gen(function* () {
//     const redis = yield* Config.all({
//       host: Config.string("HOST"),
//       port: Config.integer("PORT").pipe(Config.withDefault(6379)),
//     }).pipe(Config.nested("REDIS"), Config.option)
//
//     if (Option.isSome(redis)) {
//       return PersistenceRedis.layerResult({
//         host: redis.value.host,
//         port: redis.value.port,
//       })
//     }
//
//     return Persistence.layerResultKeyValueStore.pipe(
//       Layer.provide(NodeKeyValueStore.layerFileSystem("data/persistence")),
//     )
//   }),
// )
