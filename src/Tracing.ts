import { OtlpTracer } from "effect/unstable/observability"
import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Config } from "effect/config"
import { Redacted } from "effect/data"
import { Schema } from "effect/schema"

export const TracingLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.schema(
      Schema.Redacted(Schema.String).pipe(Schema.UndefinedOr),
      "HONEYCOMB_API_KEY",
    )
    const dataset = yield* Config.schema(
      Schema.String.pipe(Schema.withDecodingDefault(() => "stremio-effect")),
      "HONEYCOMB_DATASET",
    )
    if (apiKey === undefined) {
      const endpoint = yield* Config.schema(
        Schema.UndefinedOr(Schema.String),
        "OTEL_EXPORTER_OTLP_ENDPOINT",
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
).pipe(Layer.provide(NodeHttpClient.layerUndici))
