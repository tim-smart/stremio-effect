import * as OtlpTracer from "@effect/opentelemetry/OtlpTracer"
import { NodeHttpClient } from "@effect/platform-node"
import { Config, Effect, Layer, Redacted } from "effect"

export const TracingLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const apiKey = yield* Config.option(Config.redacted("HONEYCOMB_API_KEY"))
    const dataset = yield* Config.withDefault(
      Config.string("HONEYCOMB_DATASET"),
      "stremio-effect",
    )
    if (apiKey._tag === "None") {
      const endpoint = yield* Config.option(
        Config.string("OTEL_EXPORTER_OTLP_ENDPOINT"),
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
