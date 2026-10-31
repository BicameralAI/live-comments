import { Effect, Either } from "effect"
import type { Declaration, ParsedFile } from "../annotations/parse.js"
import { type Expansion, expand, makeEnv, memberPlaces } from "../authority/evaluate.js"
import { type Expr, parseExpression, print } from "../authority/syntax.js"
import { LOCK_FILE, matchesAny } from "../config.js"
import { compareDiagnostics, type Diagnostic, diagnostic, type Lock, type Membership, placeKey, type Snapshot } from "../domain.js"
import { compareCode, type Impact, impact } from "../lifecycle/compare.js"
import { evaluate, type Evaluation } from "../lifecycle/evaluate.js"
import { describe, type ResolveError } from "../sources/errors.js"
import type { DirectoryListing } from "../sources/provider.js"
import { Sources } from "../sources/resolve.js"
import { loadRevision, type Workspace, type WorkspaceError, writeLock } from "./workspace.js"

// The workflows behind each command. They compose the pure modules with I/O.

// ---------------------------------------------------------------------------
// check

export interface CheckResult extends Evaluation {
  readonly base?: string
}

export const check = (ws: Workspace, base?: string): Effect.Effect<CheckResult, WorkspaceError> =>
  Effect.gen(function* () {
    const ev = evaluate(ws)
    if (!base) return ev
    const baseFiles = yield* loadRevision(ws.root, base, ws.config.ignore)
    const changes = compareCode(baseFiles, ws.files, ws.config)
    return { ...ev, base, diagnostics: [...ev.diagnostics, ...changes].sort(compareDiagnostics) }
  })

export const hasErrors = (ds: ReadonlyArray<Diagnostic>) => ds.some((d) => d.severity === "error")

// ---------------------------------------------------------------------------
// sync

/** Every ref the project cites, plus the `in` refs of open questions (for answer candidates). */
export const referencedRefs = (ws: Workspace): { cited: ReadonlyArray<string>; openPlaces: ReadonlyArray<string> } => {
  const cited = new Set<string>()
  const openPlaces = new Set<string>()
  for (const f of ws.files)
    for (const d of f.declarations)
      for (const a of d.annotations) {
        if (a.kind === "source") cited.add(a.ref)
        else if (a.in && a.in._tag === "Literal" && a.in.system in ws.config.resolvers) openPlaces.add(`${a.in.system}:${a.in.path}`)
      }
  return { cited: [...cited].sort(), openPlaces: [...openPlaces].filter((r) => !cited.has(r)).sort() }
}

const allExpressions = (ws: Workspace): ReadonlyArray<Expr> => [
  ...ws.authority.definitions.map((d) => d.expr),
  ...ws.files.flatMap((f) => f.declarations.flatMap((d) => d.annotations.flatMap((a) => (a.authority ? [a.authority] : []))))
]

export interface SyncResult {
  readonly lock: Lock
  readonly impact: Impact
  readonly failures: ReadonlyArray<Diagnostic>
  readonly updated: ReadonlyArray<string>
  readonly membershipChanges: ReadonlyArray<{ place: string; added: ReadonlyArray<string>; removed: ReadonlyArray<string> }>
}

/** Resolve everything the project references and compute the new lockfile and its impact, without writing. */
export const planSync = (ws: Workspace): Effect.Effect<SyncResult, never, Sources> =>
  Effect.gen(function* () {
    const sources = yield* Sources
    const { cited, openPlaces } = referencedRefs(ws)
    const now = new Date().toISOString()

    const resolved = yield* Effect.forEach([...cited, ...openPlaces], (ref) => Effect.either(sources.resolve(ref)).pipe(Effect.map((r) => [ref, r] as const)), {
      concurrency: 4
    })

    const env = makeEnv(ws.authority, ws.lock.memberships)
    const places = new Map(allExpressions(ws).flatMap((e) => memberPlaces(e, env)).map((p) => [placeKey(p), p] as const))
    const members = yield* Effect.forEach([...places.values()], (p) => Effect.either(sources.members(p)).pipe(Effect.map((r) => [placeKey(p), r] as const)), {
      concurrency: 4
    })

    const failures: Array<Diagnostic> = []
    const newSources: Record<string, Snapshot> = {}
    const updated: Array<string> = []
    for (const [ref, r] of resolved) {
      if (Either.isRight(r)) {
        newSources[ref] = r.right
        if (ws.lock.sources[ref]?.version !== r.right.version) updated.push(ref)
        continue
      }
      const e: ResolveError = r.left
      if (openPlaces.includes(ref) && e._tag === "NotADocument") continue // an `in` place such as a team, not a single document
      const old = ws.lock.sources[ref]
      if (old) newSources[ref] = old // keep the last good snapshot so check still works offline
      failures.push(diagnostic(e._tag === "UnknownScheme" ? "LC018" : "LC007", LOCK_FILE, 0, `${ref}: ${describe(e)}`))
    }

    const newMemberships: Record<string, Membership> = {}
    const membershipChanges: Array<SyncResult["membershipChanges"][number]> = []
    for (const [place, r] of members) {
      if (Either.isRight(r)) {
        const accounts = r.right.map((a) => `${a.system}:${a.account}`).sort()
        const before = ws.lock.memberships[place]?.accounts ?? []
        const added = accounts.filter((a) => !before.includes(a))
        const removed = before.filter((a) => !accounts.includes(a))
        if (ws.lock.memberships[place] && (added.length > 0 || removed.length > 0)) membershipChanges.push({ place, added, removed })
        newMemberships[place] = { retrievedAt: now, accounts }
      } else {
        const old = ws.lock.memberships[place]
        if (old) newMemberships[place] = old
        failures.push(diagnostic("LC007", LOCK_FILE, 0, `members(${place}): ${describe(r.left)}`))
      }
    }

    const lock: Lock = { sources: newSources, memberships: newMemberships }
    const before = evaluate(ws)
    const after = evaluate({ ...ws, lock })
    return { lock, impact: impact(before, after, ws.lock, lock), failures, updated, membershipChanges }
  })

export const sync = (ws: Workspace): Effect.Effect<SyncResult, WorkspaceError, Sources> =>
  Effect.tap(planSync(ws), (r) => writeLock(ws.root, r.lock))


// ---------------------------------------------------------------------------
// read: the one read path (spec §6.2)

export const read = (ws: Workspace, ref: string): Effect.Effect<Snapshot, ResolveError | WorkspaceError, Sources> =>
  Effect.gen(function* () {
    const sources = yield* Sources
    const snap = yield* sources.resolve(ref)
    yield* writeLock(ws.root, { ...ws.lock, sources: { ...ws.lock.sources, [ref]: snap } })
    return snap
  })

/** Render a snapshot for quoting: each passage with its author. */
export const renderSnapshot = (s: Snapshot): string => {
  const lines = [`${s.ref}  (${s.uri})`, `version ${s.version} · in ${s.container || "(root)"}`, ""]
  for (const span of s.attribution) {
    const who = span.author ? `${span.author.system}:${span.author.account}${span.bot ? " (bot)" : ""}` : "unknown author"
    lines.push(`[${who}${span.createdAt ? ` · ${span.createdAt}` : ""}]`, s.text.slice(span.start, span.end), "")
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// context, who, authority, report

const findDeclaration = (f: ParsedFile, line: number): Declaration | undefined => {
  const before = f.declarations.filter((d) => d.line <= line)
  return before[before.length - 1] ?? f.declarations[0]
}

export const context = (ws: Workspace, file: string, line: number) => {
  const f = ws.files.find((x) => x.file === file)
  const decl = f ? findDeclaration(f, line) : undefined
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""
  const nearby = ws.files
    .filter((x) => x.file.startsWith(dir))
    .flatMap((x) => x.declarations.filter((d) => d.annotations.length > 0))
    .slice(0, 40)
  const counts = new Map<string, number>()
  for (const d of nearby) for (const a of d.annotations) if (a.authority) counts.set(print(a.authority), (counts.get(print(a.authority)) ?? 0) + 1)
  return {
    file,
    line,
    governed: matchesAny(ws.config.governed, file),
    sticky: ws.config.sticky,
    declaration: decl ? { name: decl.name, line: decl.line, exported: decl.exported, annotations: decl.annotations.map((a) => `@${a.kind} ${a.raw}`) } : null,
    nearby: nearby.map((d) => ({ file: d.file, name: d.name, annotations: d.annotations.map((a) => `@${a.kind} ${a.raw}`) })),
    authoritiesNearby: [...counts].sort((a, b) => b[1] - a[1]).map(([expression, uses]) => ({ expression, uses })),
    configuredSchemes: Object.keys(ws.config.resolvers)
  }
}

export const who = (ws: Workspace, text: string): Either.Either<Expansion, string> => {
  try {
    return Either.right(expand(parseExpression(text), makeEnv(ws.authority, ws.lock.memberships)))
  } catch (e) {
    return Either.left(e instanceof Error ? e.message : String(e))
  }
}

export const authorityListing = (ws: Workspace) => {
  const env = makeEnv(ws.authority, ws.lock.memberships)
  return {
    definitions: ws.authority.definitions.map((d) => ({ name: d.name, agent: d.agent, line: d.line, expression: print(d.expr), expansion: expand(d.expr, env) })),
    problems: ws.authority.problems
  }
}

export const report = (ws: Workspace) => {
  const ev = evaluate(ws)
  const opens = ev.annotations
    .filter((r) => r.annotation.kind === "open")
    .map((r) => {
      const a = r.annotation as Extract<typeof r.annotation, { kind: "open" }>
      return {
        decl: r.decl,
        line: a.line,
        question: a.question,
        ...(a.id ? { id: a.id } : {}),
        answeredBy: a.authority ? print(a.authority) : null,
        options: a.options,
        status: r.status
      }
    })
  const coverage = ws.config.governed.map((glob) => {
    const decls = ws.files.flatMap((f) => f.declarations).filter((d) => d.exported && matchesAny([glob], d.file))
    const annotated = decls.filter((d) => d.annotations.length > 0)
    return { area: glob, exported: decls.length, annotated: annotated.length }
  })
  return { opens, coverage }
}

export const directory = (system: string, scope: string | undefined): Effect.Effect<DirectoryListing, ResolveError, Sources> =>
  Effect.flatMap(Sources, (s) => s.directory(system, scope))
