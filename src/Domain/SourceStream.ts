import { Data, Order } from "effect"
import type * as Stremio from "stremio-addon-sdk"
import { bytesToSize } from "../Utils.js"
import * as Quality from "./Quality.js"

export class SourceStream extends Data.Class<{
  source: string
  infoHash: string
  magnetUri: string
  quality: string
  seeds: number
  peers: number
  sizeBytes?: number
  sizeDisplay?: string
  url?: string
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

  get asStremio(): Stremio.Stream {
    return {
      url: this.url,
      infoHash: this.infoHash,
      title: `${this.sizeFormatted}  ⬆️ ${this.seeds}`,
      name: `${this.quality}${this.url ? ` ✨` : ""}`,
      behaviorHints: {
        bingeGroup: `effect-${this.quality}`,
      } as any,
    }
  }
}
