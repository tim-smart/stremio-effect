import { ConfigProvider } from "effect/config"

export const magnetFromHash = (hash: string) =>
  `magnet:?xt=urn:btih:${hash}&${trackers}`

const trackers =
  "tr=" +
  [
    "udp://glotorrents.pw:6969/announce",
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://torrent.gresille.org:80/announce",
    "udp://tracker.openbittorrent.com:80",
    "udp://tracker.coppersurfer.tk:6969",
    "udp://tracker.leechers-paradise.org:6969",
    "udp://p4p.arenabg.ch:1337",
    "udp://tracker.internetwarriors.net:1337",
  ]
    .map(encodeURIComponent)
    .join("&tr=")

export const bytesToSize = (bytes: number) => {
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  if (bytes === 0) return "0B"
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(2)}${sizes[i]}`
}

export const infoHashFromMagnet = (magnet: string) => {
  const match = magnet.match(/urn:btih:([^&]+)/)
  return match ? match[1] : ""
}

export const qualityFromTitle = (title: string) => {
  const match = title.match(/\d{3,4}p/)
  const isHdr = title.includes("HDR")
  if (!match) {
    return "N/A"
  } else if (match[0] === "2160p" && isHdr) {
    return "2160p HDR"
  }
  return match[0]
}

export const configProviderNested = (prefix: string) =>
  ConfigProvider.fromEnv().pipe(
    ConfigProvider.nested(prefix),
    ConfigProvider.constantCase,
  )
