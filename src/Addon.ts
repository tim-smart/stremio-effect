import * as Stremio from "./Stremio.ts"
import { Layer } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/unstable/http"
import { AllSourcesDebrid } from "./Sources/All.ts"

export const AddonLive = Stremio.StremioManifest.addon({
  id: "co.timsmart.stremio.sources",
  name: "Stremio Sources",
  version: "0.0.1",
  description: "Stream results from various sources",
  catalogs: [],
  resources: ["stream"],
  types: ["movie", "tv", "series"],
}).pipe(
  Layer.provide(AllSourcesDebrid),
  HttpRouter.serve,
  Layer.provide(HttpMiddleware.layerTracerDisabledForUrls(["/health"])),
)