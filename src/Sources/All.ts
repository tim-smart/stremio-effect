import { Layer } from "effect"
import { SourceYtsLive } from "./Yts.js"
import { RealDebridLive } from "../RealDebrid.js"
import { SourceEztvLive } from "./Eztv.js"
import { SourceTpbLive } from "./Tpb.js"
import { SourceRargbLive } from "./Rargb.js"
import { SourceNyaaLive } from "./Nyaa.js"
import { Source1337xLive } from "./1337x.js"

export const AllSources = Layer.mergeAll(
  Source1337xLive,
  SourceEztvLive,
  SourceNyaaLive,
  SourceRargbLive,
  SourceTpbLive,
  SourceYtsLive,
)

export const AllSourcesDebrid = Layer.mergeAll(AllSources, RealDebridLive)
