import * as Stremio from "./Stremio.js"
import { Layer } from "effect"
import { AllSourcesDebrid } from "./Sources/All.js"
import { HttpLayerRouter } from "@effect/platform"

export const AddonLive = Stremio.StremioManifest.addon({
  id: "co.timsmart.stremio.sources",
  name: "Stremio Sources",
  version: "0.0.1",
  description: "Stream results from various sources",
  catalogs: [],
  resources: ["stream"],
  types: ["movie", "tv", "series"],
}).pipe(Layer.provide(AllSourcesDebrid), HttpLayerRouter.serve)
