import { Context, Effect, Layer, Schedule } from "effect"
import type { Config, ResolverConfig } from "../config.js"
import { type Account, type Place, parseRef, type Snapshot } from "../domain.js"
import { normalizeSegments, sha256 } from "../normalize.js"
import { Denied, ExtractionFailed, NotFound, RateLimited, type ResolveError, Unreachable, UnknownScheme } from "./errors.js"
import { extractFile } from "./file.js"
import type { DirectoryListing, Extracted, Http, Provider } from "./provider.js"
import { gdocs } from "./providers/gdocs.js"
import { github } from "./providers/github.js"
import { jira } from "./providers/jira.js"
import { linear } from "./providers/linear.js"
import { notion } from "./providers/notion.js"
import { slack } from "./providers/slack.js"
import { type Transport, type TransportConfig, Transports } from "./transport.js"

export const providers: Readonly<Record<string, Provider>> = { github, linear, notion, jira, gdocs, slack }

/** Reads sources, memberships and directories, as the project's config says. */
export class Sources extends Context.Tag("live-comments/Sources")<
  Sources,
  {
    readonly resolve: (ref: string) => Effect.Effect<Snapshot, ResolveError>
    readonly members: (place: Place) => Effect.Effect<ReadonlyArray<Account>, ResolveError>
    readonly directory: (system: string, scope: string | undefined) => Effect.Effect<DirectoryListing, ResolveError>
  }
>() {}

const retryable = (e: ResolveError) => e._tag === "Unreachable" || e._tag === "RateLimited"

const policy = <A>(ref: string, eff: Effect.Effect<A, ResolveError>): Effect.Effect<A, ResolveError> =>
  eff.pipe(
    Effect.retry({
      schedule: Schedule.exponential("300 millis").pipe(Schedule.jittered, Schedule.intersect(Schedule.recurs(3))),
      while: retryable
    }),
    Effect.timeoutFail({ duration: "90 seconds", onTimeout: () => new Unreachable({ ref, message: "timed out" }) })
  )

/** Nango or Composio, as configured; a provider with neither uses the logged-in Composio CLI. */
const transportConfig = (provider: Provider, c: Extract<ResolverConfig, { provider: string }>): TransportConfig => {
  if (c.nango) return { kind: "nango", ...c.nango }
  if (c.composio) return { kind: "composio", ...c.composio, toolkit: c.composio.toolkit ?? provider.toolkit }
  return { kind: "composio", toolkit: provider.toolkit }
}

const httpFor = (provider: Provider, transport: Transport, ref: string, configuredBase: string | undefined): Http => (req) =>
  transport.request({
    ...req,
    baseUrl: req.baseUrl ?? configuredBase ?? provider.baseUrl,
    ...(req.baseUrl !== undefined || configuredBase !== undefined ? { hostOverride: true } : {})
  }).pipe(
    Effect.mapError((f): ResolveError =>
      f.kind === "denied" ? new Denied({ ref, message: f.message }) : new Unreachable({ ref, message: f.message })
    ),
    Effect.flatMap((res): Effect.Effect<unknown, ResolveError> => {
      const cls = provider.classify?.(res.body)
      if (cls?.kind === "rate_limited" || res.status === 429) return Effect.fail(new RateLimited({ ref, message: cls?.message ?? "rate limited" }))
      if (cls?.kind === "not_found" || res.status === 404) return Effect.fail(new NotFound({ ref, message: cls?.message ?? "not found" }))
      if (cls?.kind === "denied" || res.status === 401 || res.status === 403) return Effect.fail(new Denied({ ref, message: cls?.message ?? "access denied" }))
      if (res.status !== undefined && res.status >= 500) return Effect.fail(new Unreachable({ ref, message: `HTTP ${res.status}` }))
      if (res.status !== undefined && res.status >= 400) return Effect.fail(new ExtractionFailed({ ref, message: `HTTP ${res.status}` }))
      return Effect.succeed(res.body)
    })
  )

export const toSnapshot = (ref: string, resolver: string, x: Extracted, now: Date): Snapshot => {
  const n = normalizeSegments(x.segments)
  const textSha256 = sha256(n.text)
  return {
    ref,
    uri: x.uri,
    resolver,
    retrievedAt: now.toISOString(),
    version: x.version ?? `sha256=${textSha256}`,
    container: x.container,
    ...(x.creator ? { creator: x.creator } : {}),
    ...(x.creatorIsBot ? { creatorBot: true } : {}),
    text: n.text,
    textSha256,
    attribution: n.attribution
  }
}

export const makeSources = (config: Config, root: string, transports: Context.Tag.Service<Transports>, now: () => Date = () => new Date()) => {
  const lookup = (scheme: string, ref: string) =>
    Effect.gen(function* () {
      const c = config.resolvers[scheme]
      if (!c) return yield* new UnknownScheme({ ref, message: `no resolver is configured for '${scheme}:'; run live-comments connect ${scheme}` })
      return c
    })

  const forProvider = (ref: string, c: Extract<ResolverConfig, { provider: string }>) =>
    Effect.gen(function* () {
      const provider = providers[c.provider]
      if (!provider) return yield* new UnknownScheme({ ref, message: `no provider named '${c.provider}'` })
      if (!c.baseUrl && !provider.baseUrl) {
        return yield* new UnknownScheme({ ref, message: provider.baseUrlHint ?? `set "baseUrl" for the ${provider.system} resolver` })
      }
      const transport = transports.get(transportConfig(provider, c))
      return { provider, transport, http: httpFor(provider, transport, ref, c.baseUrl) }
    })

  return Sources.of({
    resolve: (raw) =>
      Effect.gen(function* () {
        const ref = parseRef(raw)
        if (!ref) return yield* new NotFound({ ref: raw, message: "not a ref" })
        const c = yield* lookup(ref.scheme, raw)
        if ("builtin" in c) {
          const x = yield* extractFile(c.root ?? root, ref.path, raw)
          return toSnapshot(raw, "builtin:file", x, now())
        }
        const { provider, transport, http } = yield* forProvider(raw, c)
        const x = yield* policy(raw, provider.extract(ref, http))
        return toSnapshot(raw, `${transport.name}:${provider.system}`, x, now())
      }),
    members: (place) =>
      Effect.gen(function* () {
        const key = `${place.system}:${place.path}`
        const c = yield* lookup(place.system, key)
        if ("builtin" in c) return []
        const { provider, http } = yield* forProvider(key, c)
        if (!provider.members) return yield* new NotFound({ ref: key, message: `${provider.system} does not support members()` })
        return yield* policy(key, provider.members(place, http))
      }),
    directory: (system, scope) =>
      Effect.gen(function* () {
        const c = yield* lookup(system, system)
        if ("builtin" in c) return { accounts: [], places: [] }
        const { provider, http } = yield* forProvider(system, c)
        if (!provider.directory) return { accounts: [], places: [] }
        return yield* policy(system, provider.directory(scope, http))
      })
  })
}

export const SourcesLive = (config: Config, root: string) =>
  Layer.effect(
    Sources,
    Effect.map(Transports, (t) => makeSources(config, root, t))
  )
