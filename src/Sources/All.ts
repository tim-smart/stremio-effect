import { Layer } from "effect"
import { SourceYtsLive } from "./Yts.js"
import { RealDebridLayer } from "../RealDebrid.js"
import { SourceEztvLive } from "./Eztv.js"
import { SourceTpbLive } from "./Tpb.js"
import { SourceRargbLive } from "./Rargb.js"
import { SourceNyaaLive } from "./Nyaa.js"

export const AllSources = Layer.mergeAll(
  // Source1337xLive, blocked by Cloudflare
  SourceEztvLive,
  SourceNyaaLive,
  SourceRargbLive,
  SourceTpbLive,
  SourceYtsLive,
)

export const AllSourcesDebrid = Layer.mergeAll(AllSources, RealDebridLayer)
