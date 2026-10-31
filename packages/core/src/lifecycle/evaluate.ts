import { type Annotation, type Declaration, declarationKey, type OpenAnnotation, type ParsedFile, type SourceAnnotation } from "../annotations/parse.js"
import { compile, type Env, type Evidence, isExcluded, judge, makeEnv, atomHolds } from "../authority/evaluate.js"
import type { AuthorityFile } from "../authority/file.js"
import { type Expr, print } from "../authority/syntax.js"
import { type Config, matchesAny } from "../config.js"
import { accountKey, compareDiagnostics, type Diagnostic, diagnostic, type Lock, parseRef, type Snapshot } from "../domain.js"
import { normalizeText, occurrences, spansIn } from "../normalize.js"

// The comment lifecycle (spec §4, §7). A comment's status is a pure function of
// the code, the lockfile, the authority file and the config: nothing is stored.

export interface Project {
  readonly config: Config
  readonly authority: AuthorityFile
  readonly authorityPath: string
  readonly lock: Lock
  readonly files: ReadonlyArray<ParsedFile>
}

export type SourceStatus =
  | "unresolvable" // LC018: no resolver for the scheme
  | "unlocked" // LC003: not synced yet
  | "misquoted" // LC002
  | "redacted" // LC008
  | "unattributed" // LC013
  | "unauthorized" // LC009 / LC011
  | "bound" // ref resolves; nothing else to check
  | "verified" // quote found; no `by`
  | "authorized" // `by` satisfied

export type OpenStatus = "open" | "answerable" // answerable: LC019 candidates exist

export interface AnnotationResult {
  readonly decl: string
  readonly index: number
  readonly annotation: Annotation
  readonly status: SourceStatus | OpenStatus
}

export interface Evaluation {
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly annotations: ReadonlyArray<AnnotationResult>
}

const excerpt = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s)

const describeEvidence = (ev: Evidence) => `${ev.author ? accountKey(ev.author) : "an unknown author"} in ${ev.source.ref}`

/** Evidence for one `@source`: the authors of the quoted span, or the source's creator. */
export const evidenceFor = (
  a: SourceAnnotation,
  snap: Snapshot,
  index: number
): { evidence: ReadonlyArray<Evidence>; missing: "quote" | "redacted" | "author" | undefined } => {
  const source = { ref: snap.ref, container: snap.container }
  if (a.quote === undefined) {
    if (!snap.creator) return { evidence: [], missing: "author" }
    return { evidence: [{ author: snap.creator, ...(snap.creatorBot ? { bot: true } : {}), source, annotation: index }], missing: undefined }
  }
  const q = normalizeText(a.quote)
  const starts = occurrences(snap.text, q)
  if (starts.length === 0) return { evidence: [], missing: "quote" }
  // Prefer an occurrence outside redacted text, and one whose spans all have authors.
  const candidates = starts.map((start) => {
    const end = start + q.length
    const redacted = (snap.redacted ?? []).some((r) => r.start < end && r.end > start)
    const spans = spansIn(snap.attribution, start, end)
    return { redacted, spans, anonymous: spans.some((s) => !s.author) }
  })
  const best = candidates.find((c) => !c.redacted && !c.anonymous) ?? candidates.find((c) => !c.redacted) ?? candidates[0]!
  if (best.redacted) return { evidence: [], missing: "redacted" }
  const evidence = best.spans.flatMap((s): ReadonlyArray<Evidence> =>
    s.author ? [{ author: s.author, ...(s.bot ? { bot: true } : {}), source, annotation: index }] : []
  )
  return { evidence, missing: best.anonymous ? "author" : undefined }
}

export const evaluate = (p: Project): Evaluation => {
  const out: Array<Diagnostic> = []
  const results: Array<AnnotationResult> = []
  const env: Env = makeEnv(p.authority, p.lock.memberships)

  for (const problem of p.authority.problems) {
    out.push(diagnostic(problem.kind === "syntax" ? "LC001" : "LC017", p.authorityPath, problem.line, problem.message))
  }

  for (const f of p.files) {
    for (const problem of f.problems) out.push(diagnostic("LC001", problem.file, problem.line, problem.message))
    for (const d of f.declarations) evaluateDeclaration(d, p, env, out, results)
  }

  return { diagnostics: out.sort(compareDiagnostics), annotations: results }
}

const nameProblems = (expr: Expr, env: Env, file: string, line: number, decl: string, index: number, out: Array<Diagnostic>) => {
  const c = compile(expr, env)
  for (const pr of c.problems) {
    out.push(diagnostic(pr.kind === "unsynced-membership" ? "LC003" : "LC011", file, line, pr.message, { decl, annotation: index }))
  }
  return c
}

const evaluateDeclaration = (d: Declaration, p: Project, env: Env, out: Array<Diagnostic>, results: Array<AnnotationResult>) => {
  const decl = declarationKey(d)
  const at = { decl }

  if (d.exported && d.annotations.length === 0 && matchesAny(p.config.governed, d.file)) {
    out.push(diagnostic("LC004", d.file, d.line, `'${d.name}' is in a governed area but has no @source or @open`, at))
  }

  // Sources sharing the same `by` are judged together, so joint authority (`a & b`) can be met across sources.
  const groups = new Map<string, { expr: Expr; members: Array<{ a: SourceAnnotation; index: number; evidence: ReadonlyArray<Evidence> }> }>()
  const status = new Map<number, SourceStatus | OpenStatus>()

  d.annotations.forEach((a, index) => {
    if (a.kind === "open") return
    const where = { decl, annotation: index }
    const ref = parseRef(a.ref)
    if (!ref || !(ref.scheme in p.config.resolvers)) {
      out.push(diagnostic("LC018", d.file, a.line, `no resolver is configured for '${ref?.scheme ?? a.ref}:'; run live-comments connect`, where))
      status.set(index, "unresolvable")
      return
    }
    const snap = p.lock.sources[a.ref]
    if (!snap) {
      out.push(diagnostic("LC003", d.file, a.line, `${a.ref} is not in the lockfile; run live-comments sync or read`, where))
      status.set(index, "unlocked")
      return
    }
    const { evidence, missing } = evidenceFor(a, snap, index)
    if (missing === "quote") {
      out.push(diagnostic("LC002", d.file, a.line, `quote not found in ${a.ref}: "${excerpt(a.quote ?? "")}"`, where))
      status.set(index, "misquoted")
      return
    }
    if (missing === "redacted") {
      out.push(diagnostic("LC008", d.file, a.line, `quote falls inside text ${a.ref} redacted`, where))
      status.set(index, "redacted")
      return
    }
    if (a.authority && missing === "author") {
      out.push(diagnostic("LC013", d.file, a.line, `${a.ref} does not say who wrote ${a.quote === undefined ? "it" : "the quoted words"}`, where))
      status.set(index, "unattributed")
      return
    }
    if (!a.authority) {
      status.set(index, a.quote === undefined ? "bound" : "verified")
      return
    }
    const key = print(a.authority)
    const g = groups.get(key) ?? { expr: a.authority, members: [] }
    g.members.push({ a, index, evidence })
    groups.set(key, g)
  })

  for (const [key, g] of groups) {
    const first = g.members[0]!
    const compiled = nameProblems(g.expr, env, d.file, first.a.line, decl, first.index, out)
    const evidence = g.members.flatMap((m) => m.evidence)
    const j = judge(compiled, evidence, env)
    for (const m of g.members) status.set(m.index, j.ok && compiled.problems.length === 0 ? "authorized" : "unauthorized")
    if (compiled.problems.length > 0) continue
    for (const ev of j.unauthorized) {
      const m = g.members.find((x) => x.index === ev.annotation)!
      out.push(
        diagnostic("LC009", d.file, m.a.line, `${describeEvidence(ev)} does not satisfy 'by ${key}'${isExcluded(ev, env) ? " (agents and bots never hold authority)" : ""}`, {
          decl,
          annotation: m.index
        })
      )
    }
    if (j.unauthorized.length === 0 && j.unmet.length > 0) {
      out.push(diagnostic("LC009", d.file, first.a.line, `'by ${key}' needs words from ${j.unmet.join(" and ")}`, { decl, annotation: first.index }))
    }
    for (const ev of evidence) {
      if (ev.author && !isExcluded(ev, env) && !env.literals.has(accountKey(ev.author)) && !inMemberships(accountKey(ev.author), p.lock)) {
        out.push(
          diagnostic("LC010", d.file, g.members.find((m) => m.index === ev.annotation)!.a.line, `${accountKey(ev.author)} is not part of any definition in the authority file`, {
            decl,
            annotation: ev.annotation
          })
        )
      }
    }
  }

  d.annotations.forEach((a, index) => {
    if (a.kind !== "open") return
    status.set(index, evaluateOpen(a, index, d, decl, p, env, out))
  })

  d.annotations.forEach((annotation, index) => {
    results.push({ decl, index, annotation, status: status.get(index) ?? "bound" })
  })
}

const inMemberships = (key: string, lock: Lock) => Object.values(lock.memberships).some((m) => m.accounts.includes(key))

const evaluateOpen = (a: OpenAnnotation, index: number, d: Declaration, decl: string, p: Project, env: Env, out: Array<Diagnostic>): OpenStatus => {
  const where = { decl, annotation: index }
  const compiled = a.authority ? nameProblems(a.authority, env, d.file, a.line, decl, index, out) : undefined
  const who = a.authority ? ` — to be answered by ${print(a.authority)}` : ""
  out.push(diagnostic("LC100", d.file, a.line, `open: "${a.question}"${who}`, where))

  // Answer candidates: words in the `in` source written by someone who could answer.
  const place = a.in && a.in._tag === "Literal" ? `${a.in.system}:${a.in.path}` : undefined
  const snap = place ? p.lock.sources[place] : undefined
  if (!snap || (compiled && compiled.problems.length > 0)) return "open"
  const atoms = compiled ? compiled.clauses.flat() : []
  let found = 0
  for (const span of snap.attribution) {
    if (!span.author) continue
    const ev: Evidence = { author: span.author, ...(span.bot ? { bot: true } : {}), source: { ref: snap.ref, container: snap.container }, annotation: index }
    const ok = atoms.length > 0 ? atoms.some((atom) => atomHolds(atom, ev, env)) : !isExcluded(ev, env)
    if (!ok) continue
    found++
    if (found <= 5) {
      out.push(
        diagnostic("LC019", d.file, a.line, `possible answer in ${snap.ref} by ${accountKey(span.author)}: "${excerpt(snap.text.slice(span.start, span.end), 200)}"`, where)
      )
    }
  }
  return found > 0 ? "answerable" : "open"
}
