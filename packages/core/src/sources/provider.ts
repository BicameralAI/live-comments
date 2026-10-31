import type { Effect } from "effect"
import type { Account, Place, Ref, Segment } from "../domain.js"
import type { ResolveError } from "./errors.js"
import type { HttpRequest } from "./transport.js"

// A provider knows one tool's API: which requests to make for a ref, and how to
// turn the raw responses into segments with authors (the extractor).

export interface Extracted {
  readonly uri: string
  readonly version?: string
  readonly container: string
  readonly creator?: Account
  readonly creatorIsBot?: boolean
  readonly segments: ReadonlyArray<Segment>
}

export interface DirectoryListing {
  readonly accounts: ReadonlyArray<{ readonly account: string; readonly name?: string; readonly email?: string }>
  readonly places: ReadonlyArray<{ readonly place: string; readonly name?: string }>
}

/** Sends a request and returns the parsed body, with HTTP failures already mapped to errors. */
export type Http = (req: Omit<HttpRequest, "baseUrl">) => Effect.Effect<unknown, ResolveError>

export interface Provider {
  /** The ref scheme and account system, e.g. "github". */
  readonly system: string
  /** Composio toolkit slug. */
  readonly toolkit: string
  readonly baseUrl: string
  /** Recognize provider-specific error bodies, for transports that cannot report a status. */
  readonly classify?: (body: unknown) => { kind: "not_found" | "denied" | "rate_limited"; message: string } | undefined
  readonly extract: (ref: Ref, http: Http) => Effect.Effect<Extracted, ResolveError>
  readonly members?: (place: Place, http: Http) => Effect.Effect<ReadonlyArray<Account>, ResolveError>
  readonly directory?: (scope: string | undefined, http: Http) => Effect.Effect<DirectoryListing, ResolveError>
}

// Small helpers for reading untyped JSON.
export const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
export const arr = (v: unknown): ReadonlyArray<unknown> => (Array.isArray(v) ? v : [])
