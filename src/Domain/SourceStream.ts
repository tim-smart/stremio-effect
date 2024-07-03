import { Data, Order } from "effect"
import type * as Stremio from "stremio-addon-sdk"
import { bytesToSize, qualityFromTitle } from "../Utils.js"
import * as Quality from "./Quality.js"
import { Schema } from "@effect/schema"

export class SourceStream extends Schema.TaggedClass<SourceStream>()(
  "SourceStream",
  {
    source: Schema.String,
    title: Schema.String,
    infoHash: Schema.String,
    magnetUri: Schema.String,
    quality: Schema.String,
    seeds: Schema.Number,
    peers: Schema.Number,
    sizeBytes: Schema.optional(Schema.Number),
    sizeDisplay: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
    verified: Schema.optional(Schema.Boolean),
  },
) {
  static Array = Schema.Array(this)

  static Order = Order.struct({
    quality: Quality.Order,
    seeds: Order.reverse(Order.number),
  })

  get sizeFormatted() {
    if (this.sizeBytes) {
      return bytesToSize(this.sizeBytes)
    } else if (this.sizeDisplay) {
      return this.sizeDisplay
    }
    return "0B"
  }

  get qualityFormatted() {
    switch (this.quality) {
      case "2160p":
        return "4K"
      default:
        return this.quality
    }
  }

  get asStremio(): Stremio.Stream {
    return {
      url: this.url,
      infoHash: this.infoHash,
      title: `${this.sizeFormatted}  ⬆️ ${this.seeds}`,
      name: `${this.qualityFormatted}${this.url ? ` ✨` : ""}`,
      behaviorHints: {
        bingeGroup: `effect-${this.quality}`,
      } as any,
    }
  }
}

export class SourceSeason extends Data.TaggedClass("SourceSeason")<{
  source: string
  title: string
  infoHash: string
  magnetUri: string
  seeds: number
  peers: number
  verified?: boolean
}> {
  readonly quality = qualityFromTitle(this.title)
}
