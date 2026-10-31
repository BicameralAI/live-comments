// Shared domain types. Everything here is plain data so the pure modules
// (authority, annotations, lifecycle) can be used without Effect.

export interface Account {
  readonly system: string
  readonly account: string
}

export const accountKey = (a: Account): string => `${a.system}:${a.account}`

export const parseAccountKey = (key: string): Account => {
  const i = key.indexOf(":")
  return { system: key.slice(0, i), account: key.slice(i + 1) }
}

/** A run of text with the account that wrote it, as an extractor reports it. */
export interface Segment {
  readonly text: string
  readonly author?: Account
  /** True when the provider reports the author as a bot or app. */
  readonly bot?: boolean
  readonly createdAt?: string
  readonly id?: string
}

/** A span of a snapshot's normalized text, with its author. */
export interface Span {
  readonly start: number
  readonly end: number
  readonly author?: Account
  readonly bot?: boolean
  readonly createdAt?: string
  readonly id?: string
}

export interface Snapshot {
  readonly ref: string
  readonly uri: string
  readonly resolver: string
  readonly retrievedAt: string
  readonly version: string
  /** Where the source lives in its system, e.g. "team/PRICING" or "acme/shop". */
  readonly container: string
  readonly creator?: Account
  readonly creatorBot?: boolean
  readonly text: string
  readonly textSha256: string
  readonly attribution: ReadonlyArray<Span>
  readonly redacted?: ReadonlyArray<{ readonly start: number; readonly end: number }>
}

export interface Membership {
  readonly retrievedAt: string
  readonly accounts: ReadonlyArray<string>
}

export interface Lock {
  readonly sources: Readonly<Record<string, Snapshot>>
  readonly memberships: Readonly<Record<string, Membership>>
}

export const emptyLock: Lock = { sources: {}, memberships: {} }

// ---------------------------------------------------------------------------
// Refs and places

export interface Ref {
  readonly raw: string
  readonly scheme: string
  readonly path: string
}

const REF = /^([A-Za-z][\w+.-]*):(\S+)$/

export const parseRef = (raw: string): Ref | undefined => {
  const m = REF.exec(raw.trim())
  return m ? { raw: raw.trim(), scheme: m[1]!, path: m[2]! } : undefined
}

export interface Place {
  readonly system: string
  readonly path: string
}

export const placeKey = (p: Place): string => `${p.system}:${p.path}`

/**
 * A place contains a source when it names the source itself, or a prefix of
 * the source's container at a path boundary.
 */
export const placeContains = (place: Place, source: { ref: string; container: string }): boolean => {
  const ref = parseRef(source.ref)
  if (!ref || ref.scheme !== place.system) return false
  if (ref.path === place.path) return true
  const c = source.container
  return c === place.path || c.startsWith(place.path + "/")
}

// ---------------------------------------------------------------------------
// Diagnostics

export type Severity = "error" | "warn" | "info"

export type Code =
  | "LC001" | "LC002" | "LC003" | "LC004" | "LC006" | "LC007" | "LC008" | "LC009"
  | "LC010" | "LC011" | "LC013" | "LC014" | "LC015" | "LC016" | "LC017" | "LC018"
  | "LC019" | "LC100"

export const severityOf: Record<Code, Severity> = {
  LC001: "error", LC002: "error", LC003: "error", LC004: "error", LC006: "error",
  LC007: "error", LC008: "error", LC009: "error", LC010: "warn", LC011: "error",
  LC013: "error", LC014: "info", LC015: "error", LC016: "info", LC017: "error",
  LC018: "error", LC019: "info", LC100: "info"
}

export interface Diagnostic {
  readonly code: Code
  readonly severity: Severity
  readonly file: string
  readonly line: number
  readonly message: string
  /** Declaration key, when the diagnostic belongs to one. */
  readonly decl?: string
  /** Index of the annotation within its declaration. */
  readonly annotation?: number
}

export const diagnostic = (
  code: Code,
  file: string,
  line: number,
  message: string,
  extra: { decl?: string; annotation?: number } = {}
): Diagnostic => ({ code, severity: severityOf[code], file, line, message, ...extra })

export const compareDiagnostics = (a: Diagnostic, b: Diagnostic): number =>
  a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code) ||
  a.message.localeCompare(b.message)
