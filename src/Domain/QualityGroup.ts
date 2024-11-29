import { SourceStream } from "./SourceStream.js"

export interface QualityGroup extends Record<string, Array<SourceStream>> {}

export const empty = (): QualityGroup => ({
  "3D": [],
  "2160p HDR": [],
  "2160p": [],
  "1080p": [],
  "720p": [],
  "480p": [],
})

export const unsafeAdd = (
  self: QualityGroup,
  stream: SourceStream,
): QualityGroup => {
  if (self[stream.quality] === undefined) {
    self[stream.quality] = [stream]
  } else if (self[stream.quality].length < 3) {
    self[stream.quality].push(stream)
  }
  return self
}

export const hasEnough = (self: QualityGroup): boolean => {
  return (
    (self["2160p HDR"].length >= 2 &&
      self["2160p"].length >= 3 &&
      self["1080p"].length >= 3) ||
    Object.values(self).flat().length >= 12
  )
}
