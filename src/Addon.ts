import * as Stremio from "./Stremio.js"
import { Layer } from "effect"
import { AllSourcesDebrid } from "./Sources/All.js"

export const AddonLive = Stremio.layerAddon.pipe(
  Layer.provide([
    Stremio.StremioManifest.layer({
      id: "co.timsmart.stremio.sources",
      name: "Stremio Sources",
      version: "0.0.1",
      description: "Stream results from various sources",
      catalogs: [],
      resources: ["stream"],
      types: ["movie", "tv", "series"],
    }),
    AllSourcesDebrid,
  ]),
)
