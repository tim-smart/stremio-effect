import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Context, Effect, Layer } from "effect"

const make = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      HttpClientRequest.prependUrl("https://itorrents.org/torrent"),
    ),
    HttpClient.filterStatusOk,
  )

  const fromHash = (hash: string) =>
    client.get(`/${hash}.torrent`).pipe(HttpClientResponse.stream)

  return { fromHash } as const
})

export class Torrent extends Context.Tag("Torrent")<
  Torrent,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.effect(Torrent, make)
}
