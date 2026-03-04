import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability"
import { NodeHttpClient } from "@effect/platform-node"
import { Config, Effect, Layer, Redacted } from "effect"

export const TracingLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("HONEYCOMB_API_KEY").pipe(
      Config.withDefault(undefined),
    )
    const dataset = yield* Config.string("HONEYCOMB_DATASET").pipe(
      Config.withDefault("stremio-effect"),
    )
    if (apiKey === undefined) {
      const endpoint = yield* Config.string("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(
        Config.withDefault(undefined),
      )
      if (!endpoint) {
        return Layer.empty
      }
      return OtlpTracer.layer({
        resource: {
          serviceName: dataset,
        },
        url: `${endpoint}/v1/traces`,
      })
    }

    const headers = {
      "X-Honeycomb-Team": Redacted.value(apiKey),
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
).pipe(Layer.provide([NodeHttpClient.layerUndici, OtlpSerialization.layerJson]))
