import { Layer } from "effect"
import { SourceYtsLive } from "./Yts.js"
import { RealDebridLive } from "../RealDebrid.js"
import { SourceEztvLive } from "./Eztv.js"
import { SourceTpbLive } from "./Tpb.js"
import { SourceRargbLive } from "./Rargb.js"

export const AllSources = Layer.mergeAll(
  SourceYtsLive,
  SourceEztvLive,
  SourceTpbLive,
  SourceRargbLive,
)

export const AllSourcesDebrid = Layer.mergeAll(AllSources, RealDebridLive)
