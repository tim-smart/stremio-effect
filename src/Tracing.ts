import { OtlpTracer } from "effect/unstable/tracing"
import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Config } from "effect/config"
import { Redacted } from "effect/data"

export const TracingLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.option(Config.Redacted("HONEYCOMB_API_KEY"))
    const dataset = yield* Config.withDefault(
      Config.String("HONEYCOMB_DATASET"),
      "stremio-effect",
    )
    if (apiKey._tag === "None") {
      const endpoint = yield* Config.option(
        Config.String("OTEL_EXPORTER_OTLP_ENDPOINT"),
      )
      if (endpoint._tag === "None") {
        return Layer.empty
      }
      return OtlpTracer.layer({
        resource: {
          serviceName: dataset,
        },
        url: `${endpoint.value}/v1/traces`,
      })
    }

    const headers = {
      "X-Honeycomb-Team": Redacted.value(apiKey.value),
      "X-Honeycomb-Dataset": dataset,
    }

    return OtlpTracer.layer({
      resource: {
        serviceName: dataset,
      },
      url: "https://api.honeycomb.io/v1/traces",
      headers,
    })
  }),
).pipe(Layer.provide(NodeHttpClient.layerUndici))
