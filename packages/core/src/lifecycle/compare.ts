import { declarationKey, type Declaration, type OpenAnnotation, type ParsedFile, type SourceAnnotation } from "../annotations/parse.js"
import { print } from "../authority/syntax.js"
import type { Config } from "../config.js"
import { compareDiagnostics, type Diagnostic, diagnostic, type Lock } from "../domain.js"
import type { Evaluation } from "./evaluate.js"

// Changes between two states of a project: authority edits and fills in code
// review (spec §7.4, §4.2), and the impact of a sync (spec §8).

const index = (files: ReadonlyArray<ParsedFile>) => {
  const m = new Map<string, Declaration>()
  for (const f of files) for (const d of f.declarations) m.set(declarationKey(d), d)
  return m
}

const authorityOf = (d: Declaration): ReadonlyArray<string> =>
  d.annotations
    .map((a) => (a.authority ? `by ${print(a.authority)}` : undefined))
    .filter((x): x is string => x !== undefined)
    .sort()

const sameOpen = (x: OpenAnnotation, y: OpenAnnotation) => (x.id !== undefined || y.id !== undefined ? x.id === y.id : x.question === y.question)
const sameSource = (x: SourceAnnotation, y: SourceAnnotation) => x.ref === y.ref && x.quote === y.quote

/** Authority changes (LC016) and fills that dropped sticky arguments (LC015), base → head. */
export const compareCode = (base: ReadonlyArray<ParsedFile>, head: ReadonlyArray<ParsedFile>, config: Config): ReadonlyArray<Diagnostic> => {
  const out: Array<Diagnostic> = []
  const before = index(base)
  for (const [key, h] of index(head)) {
    const b = before.get(key)
    if (!b) continue
    const was = authorityOf(b)
    const now = authorityOf(h)
    if (was.join("\n") !== now.join("\n")) {
      out.push(diagnostic("LC016", h.file, h.line, `authority changed on '${h.name}': ${was.join(", ") || "none"} → ${now.join(", ") || "none"}`, { decl: key }))
    }
    if (!config.sticky) continue
    const headOpens = h.annotations.filter((a): a is OpenAnnotation => a.kind === "open")
    const headSources = h.annotations.filter((a): a is SourceAnnotation => a.kind === "source")
    const baseSources = b.annotations.filter((a): a is SourceAnnotation => a.kind === "source")
    const added = headSources.filter((s) => !baseSources.some((t) => sameSource(s, t)))
    for (const open of b.annotations.filter((a): a is OpenAnnotation => a.kind === "open")) {
      if (headOpens.some((o) => sameOpen(o, open))) continue // still open
      if (!open.authority || added.length === 0) continue // removed without an answer, or nothing to carry
      const want = print(open.authority)
      if (!added.some((s) => s.authority && print(s.authority) === want)) {
        out.push(
          diagnostic("LC015", h.file, h.line, `'${h.name}' answered the open question "${open.question}" but the new @source dropped 'by ${want}'`, { decl: key })
        )
      }
    }
  }
  return out.sort(compareDiagnostics)
}

export interface Impact {
  /** Diagnostics present after but not before. */
  readonly appeared: ReadonlyArray<Diagnostic>
  /** Diagnostics present before but not after. */
  readonly resolved: ReadonlyArray<Diagnostic>
  /** Sync-only diagnostics: stale quotes (LC006) and changed ref-only sources (LC014). */
  readonly sync: ReadonlyArray<Diagnostic>
}

const identity = (d: Diagnostic) => `${d.code}|${d.file}|${d.decl ?? ""}|${d.annotation ?? ""}|${d.code === "LC019" || d.code === "LC009" ? d.message : ""}`

/** What a change of inputs did to every comment, e.g. old lockfile → new lockfile. */
export const impact = (before: Evaluation, after: Evaluation, oldLock: Lock, newLock: Lock): Impact => {
  const b = new Map(before.diagnostics.map((d) => [identity(d), d]))
  const a = new Map(after.diagnostics.map((d) => [identity(d), d]))
  const appeared = [...a].filter(([k]) => !b.has(k)).map(([, d]) => d)
  const resolved = [...b].filter(([k]) => !a.has(k)).map(([, d]) => d)

  const sync: Array<Diagnostic> = []
  const statusBefore = new Map(before.annotations.map((r) => [`${r.decl}|${r.index}`, r.status]))
  for (const r of after.annotations) {
    if (r.annotation.kind !== "source") continue
    const was = statusBefore.get(`${r.decl}|${r.index}`)
    const file = r.decl.slice(0, r.decl.lastIndexOf("#"))
    const at = { decl: r.decl, annotation: r.index }
    if (r.status === "misquoted" && was !== undefined && was !== "misquoted" && was !== "unlocked") {
      sync.push(diagnostic("LC006", file, r.annotation.line, `stale: the quote no longer appears in ${r.annotation.ref}`, at))
    }
    const ov = oldLock.sources[r.annotation.ref]?.version
    const nv = newLock.sources[r.annotation.ref]?.version
    if (r.annotation.quote === undefined && ov !== undefined && nv !== undefined && ov !== nv) {
      sync.push(diagnostic("LC014", file, r.annotation.line, `${r.annotation.ref} changed since it was cited`, at))
    }
  }
  return { appeared: appeared.sort(compareDiagnostics), resolved: resolved.sort(compareDiagnostics), sync: sync.sort(compareDiagnostics) }
}
