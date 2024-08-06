import { Order as Order_ } from "effect"

const priorities = [
  ["3D", 0],
  ["2160p", 1],
  ["1080p", 2],
  ["720p", 3],
  ["480p", 4],
] as const

const priority = (quality: string) =>
  priorities.find(([q]) => quality.startsWith(q))?.[1] ?? priorities.length

export const Order = Order_.make<string>((a, b) => {
  const aPriority = priority(a)
  const bPriority = priority(b)
  return aPriority < bPriority ? -1 : aPriority > bPriority ? 1 : 0
})
