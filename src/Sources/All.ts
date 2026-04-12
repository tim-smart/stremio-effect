import { Layer } from "effect"
import { SourceYtsLive } from "./Yts.ts"
import { RealDebridLayer } from "../RealDebrid.ts"
import { SourceEztvLive } from "./Eztv.ts"
import { SourceTpbLive } from "./Tpb.ts"
import { SourceRargbLive } from "./Rargb.ts"
import { SourceNyaaLive } from "./Nyaa.ts"

export const AllSources = Layer.mergeAll(
  // Source1337xLive, blocked by Cloudflare
  SourceEztvLive,
  SourceNyaaLive,
  SourceRargbLive,
  SourceTpbLive,
  SourceYtsLive,
)

export const AllSourcesDebrid = Layer.mergeAll(AllSources, RealDebridLayer)