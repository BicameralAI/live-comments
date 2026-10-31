import { Either } from "effect"
import type { Account, Lock, Membership, Snapshot, Span } from "./domain.js"

// live-comments.lock.json (spec §8). Keys are written in sorted order so the
// file diffs cleanly in review.

const sortKeys = <T>(o: Readonly<Record<string, T>>): Record<string, T> =>
  Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]!]))

const encodeSpan = (s: Span) => ({
  start: s.start,
  end: s.end,
  ...(s.author ? { author: s.author } : {}),
  ...(s.bot ? { bot: true } : {}),
  ...(s.createdAt ? { created_at: s.createdAt } : {}),
  ...(s.id ? { id: s.id } : {})
})

const encodeSnapshot = (s: Snapshot) => ({
  uri: s.uri,
  resolver: s.resolver,
  retrieved_at: s.retrievedAt,
  version: s.version,
  container: s.container,
  ...(s.creator ? { creator: s.creator } : {}),
  ...(s.creatorBot ? { creator_bot: true } : {}),
  text_sha256: s.textSha256,
  text: s.text,
  attribution: s.attribution.map(encodeSpan),
  ...(s.redacted && s.redacted.length > 0 ? { redacted: s.redacted } : {})
})

export const encodeLock = (lock: Lock): string =>
  JSON.stringify(
    {
      sources: sortKeys(Object.fromEntries(Object.entries(lock.sources).map(([k, v]) => [k, encodeSnapshot(v)]))),
      memberships: sortKeys(
        Object.fromEntries(
          Object.entries(lock.memberships).map(([k, v]) => [k, { retrieved_at: v.retrievedAt, accounts: [...v.accounts].sort() }])
        )
      )
    },
    null,
    2
  ) + "\n"

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {})
const s = (v: unknown, field: string): string => {
  if (typeof v !== "string") throw new Error(`expected '${field}' to be a string`)
  return v
}
const account = (v: unknown): Account | undefined => {
  const o = obj(v)
  return typeof o.system === "string" && typeof o.account === "string" ? { system: o.system, account: o.account } : undefined
}

export const decodeLock = (json: string): Either.Either<Lock, string> => {
  try {
    const root = obj(JSON.parse(json))
    const sources: Record<string, Snapshot> = {}
    for (const [ref, raw] of Object.entries(obj(root.sources))) {
      const o = obj(raw)
      const creator = account(o.creator)
      sources[ref] = {
        ref,
        uri: s(o.uri, "uri"),
        resolver: s(o.resolver, "resolver"),
        retrievedAt: s(o.retrieved_at, "retrieved_at"),
        version: s(o.version, "version"),
        container: typeof o.container === "string" ? o.container : "",
        ...(creator ? { creator } : {}),
        ...(o.creator_bot === true ? { creatorBot: true } : {}),
        text: s(o.text, "text"),
        textSha256: s(o.text_sha256, "text_sha256"),
        attribution: (Array.isArray(o.attribution) ? o.attribution : []).map((a): Span => {
          const r = obj(a)
          const author = account(r.author)
          return {
            start: Number(r.start),
            end: Number(r.end),
            ...(author ? { author } : {}),
            ...(r.bot === true ? { bot: true } : {}),
            ...(typeof r.created_at === "string" ? { createdAt: r.created_at } : {}),
            ...(typeof r.id === "string" ? { id: r.id } : {})
          }
        }),
        ...(Array.isArray(o.redacted) ? { redacted: o.redacted.map((r) => ({ start: Number(obj(r).start), end: Number(obj(r).end) })) } : {})
      }
    }
    const memberships: Record<string, Membership> = {}
    for (const [place, raw] of Object.entries(obj(root.memberships))) {
      const o = obj(raw)
      memberships[place] = {
        retrievedAt: s(o.retrieved_at, "retrieved_at"),
        accounts: (Array.isArray(o.accounts) ? o.accounts : []).filter((x): x is string => typeof x === "string")
      }
    }
    return Either.right({ sources, memberships })
  } catch (e) {
    return Either.left(`live-comments.lock.json: ${e instanceof Error ? e.message : String(e)}`)
  }
}
