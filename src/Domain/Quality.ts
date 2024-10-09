import { Order as Order_ } from "effect"

const priorities = [
  ["3D", 0],
  ["2160p HDR", 1],
  ["2160p", 2],
  ["1080p", 3],
  ["720p", 4],
  ["480p", 5],
] as const

const priority = (quality: string) =>
  priorities.find(([q]) => quality.startsWith(q))?.[1] ?? priorities.length

export const Order = Order_.make<string>((a, b) => {
  const aPriority = priority(a)
  const bPriority = priority(b)
  return aPriority < bPriority ? -1 : aPriority > bPriority ? 1 : 0
})
