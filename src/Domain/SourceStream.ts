import { Data, Order } from "effect"
import type * as Stremio from "stremio-addon-sdk"
import { bytesToSize, qualityFromTitle } from "../Utils.js"
import * as Quality from "./Quality.js"

export class SourceStream extends Data.TaggedClass("SourceStream")<{
  source: string
  title: string
  infoHash: string
  magnetUri: string
  quality: string
  seeds: number
  peers: number
  sizeBytes?: number
  sizeDisplay?: string
  url?: string
  verified?: boolean
}> {
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
