import { type Account, accountKey, type Membership, type Place, placeContains, placeKey } from "../domain.js"
import type { AuthorityFile, Definition } from "./file.js"
import { type Expr, print } from "./syntax.js"

// Evaluating authority expressions against who wrote the quoted words (spec §7).
// Expressions are expanded to disjunctive normal form: a list of clauses, each
// a list of atoms "someone in WHO, writing in WHERE". A clause holds when every
// atom is met by some piece of evidence.

export interface Env {
  readonly definitions: ReadonlyMap<string, Definition>
  /** Account keys defined with `agent`. They never satisfy anything. */
  readonly agents: ReadonlySet<string>
  /** Every account or place literal written in the authority file. */
  readonly literals: ReadonlySet<string>
  readonly memberships: Readonly<Record<string, Membership>>
}

export const makeEnv = (file: AuthorityFile, memberships: Readonly<Record<string, Membership>> = {}): Env => {
  const definitions = new Map<string, Definition>()
  for (const d of file.definitions) if (!definitions.has(d.name)) definitions.set(d.name, d)
  const agents = new Set<string>()
  const literals = new Set<string>()
  const collect = (e: Expr, into: Set<string>): void => {
    switch (e._tag) {
      case "Literal":
        into.add(`${e.system}:${e.path}`)
        return
      case "Members":
        return collect(e.place, into)
      case "Or":
      case "And":
        collect(e.left, into)
        return collect(e.right, into)
      case "In":
        collect(e.who, into)
        return collect(e.where, into)
      default:
        return
    }
  }
  for (const d of file.definitions) collect(d.expr, d.agent ? agents : literals)
  return { definitions, agents, literals, memberships }
}

export type Who =
  | { readonly anyone: true }
  | { readonly anyone: false; readonly accounts: ReadonlySet<string> }

export interface Atom {
  readonly who: Who
  readonly where?: ReadonlyArray<Place>
  /** Human-readable form, for messages. */
  readonly label: string
}

export type Clause = ReadonlyArray<Atom>

export interface EvalProblem {
  readonly kind: "unknown-name" | "not-a-place" | "not-people" | "unsynced-membership" | "too-large"
  readonly message: string
  readonly name?: string
}

export interface Compiled {
  readonly clauses: ReadonlyArray<Clause>
  readonly problems: ReadonlyArray<EvalProblem>
}

const MAX_CLAUSES = 512
const MAX_DEPTH = 64

export const compile = (expr: Expr, env: Env): Compiled => {
  const problems: Array<EvalProblem> = []
  const problem = (p: EvalProblem) => {
    if (!problems.some((q) => q.message === p.message)) problems.push(p)
  }

  const where = (e: Expr, depth: number): ReadonlyArray<Place> => {
    if (depth > MAX_DEPTH) return []
    switch (e._tag) {
      case "Name": {
        const d = env.definitions.get(e.name)
        if (!d) {
          problem({ kind: "unknown-name", name: e.name, message: `'${e.name}' is not defined in the authority file` })
          return []
        }
        return where(d.expr, depth + 1)
      }
      case "Literal":
        return [{ system: e.system, path: e.path }]
      case "Or":
        return [...where(e.left, depth + 1), ...where(e.right, depth + 1)]
      default:
        problem({ kind: "not-a-place", message: `'${print(e)}' is not a place` })
        return []
    }
  }

  const members = (places: ReadonlyArray<Place>): ReadonlySet<string> => {
    const out = new Set<string>()
    for (const p of places) {
      const m = env.memberships[placeKey(p)]
      if (!m) {
        problem({ kind: "unsynced-membership", message: `members(${placeKey(p)}) has not been synced; run sync` })
        continue
      }
      for (const a of m.accounts) out.add(a)
    }
    return out
  }

  const people = (e: Expr, depth: number): Who => {
    if (depth > MAX_DEPTH) return { anyone: false, accounts: new Set() }
    switch (e._tag) {
      case "Name": {
        const d = env.definitions.get(e.name)
        if (!d) {
          problem({ kind: "unknown-name", name: e.name, message: `'${e.name}' is not defined in the authority file` })
          return { anyone: false, accounts: new Set() }
        }
        return people(d.expr, depth + 1)
      }
      case "Literal":
        return { anyone: false, accounts: new Set([`${e.system}:${e.path}`]) }
      case "Anyone":
        return { anyone: true }
      case "Members":
        return { anyone: false, accounts: members(where(e.place, depth + 1)) }
      case "Or": {
        const l = people(e.left, depth + 1)
        const r = people(e.right, depth + 1)
        if (l.anyone || r.anyone) return { anyone: true }
        return { anyone: false, accounts: new Set([...l.accounts, ...r.accounts]) }
      }
      default:
        problem({ kind: "not-people", message: `'${print(e)}' is not a set of people` })
        return { anyone: false, accounts: new Set() }
    }
  }

  const dnf = (e: Expr, depth: number): ReadonlyArray<Clause> => {
    if (depth > MAX_DEPTH) return []
    if (isPeople(e, env)) return [[{ who: people(e, depth), label: print(e) }]]
    switch (e._tag) {
      case "Name": {
        const d = env.definitions.get(e.name)
        return d ? dnf(d.expr, depth + 1) : []
      }
      case "Or":
        return cap([...dnf(e.left, depth + 1), ...dnf(e.right, depth + 1)])
      case "And": {
        const l = dnf(e.left, depth + 1)
        const r = dnf(e.right, depth + 1)
        return cap(l.flatMap((a) => r.map((b) => [...a, ...b])))
      }
      case "In": {
        if (!isPeople(e.who, env)) {
          problem({ kind: "not-people", message: `'${print(e.who)}' is not a set of people, so it cannot be used before 'in'` })
          return []
        }
        const places = where(e.where, depth + 1)
        return [[{ who: people(e.who, depth + 1), where: places, label: `${print(e.who)} in ${print(e.where)}` }]]
      }
      default:
        return []
    }
  }

  const cap = (cs: ReadonlyArray<Clause>): ReadonlyArray<Clause> => {
    if (cs.length > MAX_CLAUSES) {
      problem({ kind: "too-large", message: `expression expands to more than ${MAX_CLAUSES} alternatives` })
      return cs.slice(0, MAX_CLAUSES)
    }
    return cs
  }

  return { clauses: dnf(expr, 0), problems }
}

/** True when an expression denotes only people (no `in`, no `&`). */
const isPeople = (e: Expr, env: Env, depth = 0): boolean => {
  if (depth > MAX_DEPTH) return false
  switch (e._tag) {
    case "Name": {
      const d = env.definitions.get(e.name)
      return d ? isPeople(d.expr, env, depth + 1) : true
    }
    case "Literal":
    case "Anyone":
    case "Members":
      return true
    case "Or":
      return isPeople(e.left, env, depth + 1) && isPeople(e.right, env, depth + 1)
    case "And":
    case "In":
      return false
  }
}

// ---------------------------------------------------------------------------
// Evidence and satisfaction

export interface Evidence {
  readonly author?: Account
  readonly bot?: boolean
  /** Where the words were written. */
  readonly source: { readonly ref: string; readonly container: string }
  /** Index of the annotation the evidence came from. */
  readonly annotation: number
}

export const isExcluded = (ev: Evidence, env: Env): boolean =>
  !ev.author || ev.bot === true || env.agents.has(accountKey(ev.author))

export const atomHolds = (atom: Atom, ev: Evidence, env: Env): boolean => {
  if (isExcluded(ev, env)) return false
  const key = accountKey(ev.author!)
  if (!atom.who.anyone && !atom.who.accounts.has(key)) return false
  if (atom.where && !atom.where.some((p) => placeContains(p, ev.source))) return false
  return true
}

export interface Judgement {
  readonly ok: boolean
  /** Evidence whose author satisfies no part of the expression. */
  readonly unauthorized: ReadonlyArray<Evidence>
  /** For a failed expression: the atoms of the closest clause that nobody met. */
  readonly unmet: ReadonlyArray<string>
  /** For a passed expression: which evidence met each atom. */
  readonly proof: ReadonlyArray<{ readonly atom: string; readonly evidence: Evidence }>
}

export const judge = (compiled: Compiled, evidence: ReadonlyArray<Evidence>, env: Env): Judgement => {
  const atoms = compiled.clauses.flat()
  const unauthorized = evidence.filter((ev) => !atoms.some((a) => atomHolds(a, ev, env)))
  let best: { unmet: ReadonlyArray<string>; proof: Array<{ atom: string; evidence: Evidence }> } | undefined
  for (const clause of compiled.clauses) {
    const proof: Array<{ atom: string; evidence: Evidence }> = []
    const unmet: Array<string> = []
    for (const atom of clause) {
      const ev = evidence.find((e) => atomHolds(atom, e, env))
      if (ev) proof.push({ atom: atom.label, evidence: ev })
      else unmet.push(atom.label)
    }
    if (!best || unmet.length < best.unmet.length) best = { unmet, proof }
    if (unmet.length === 0) break
  }
  const satisfied = best !== undefined && best.unmet.length === 0
  return {
    ok: satisfied && unauthorized.length === 0,
    unauthorized,
    unmet: best?.unmet ?? [],
    proof: satisfied ? best!.proof : []
  }
}

// ---------------------------------------------------------------------------
// Expansion, for `who` and `authority`

export interface Expansion {
  readonly expression: string
  readonly alternatives: ReadonlyArray<ReadonlyArray<{ readonly people: "anyone" | ReadonlyArray<string>; readonly places?: ReadonlyArray<string> }>>
  readonly problems: ReadonlyArray<string>
}

export const expand = (expr: Expr, env: Env): Expansion => {
  const c = compile(expr, env)
  return {
    expression: print(expr),
    alternatives: c.clauses.map((clause) =>
      clause.map((atom) => ({
        people: atom.who.anyone ? ("anyone" as const) : [...atom.who.accounts].filter((a) => !env.agents.has(a)).sort(),
        ...(atom.where ? { places: atom.where.map(placeKey) } : {})
      }))
    ),
    problems: c.problems.map((p) => p.message)
  }
}

/** Every place an expression asks `members(…)` of, following names. */
export const memberPlaces = (expr: Expr, env: Env, depth = 0): ReadonlyArray<Place> => {
  if (depth > MAX_DEPTH) return []
  const placesOf = (e: Expr, d: number): ReadonlyArray<Place> => {
    if (d > MAX_DEPTH) return []
    switch (e._tag) {
      case "Name": {
        const def = env.definitions.get(e.name)
        return def ? placesOf(def.expr, d + 1) : []
      }
      case "Literal":
        return [{ system: e.system, path: e.path }]
      case "Or":
        return [...placesOf(e.left, d + 1), ...placesOf(e.right, d + 1)]
      default:
        return []
    }
  }
  switch (expr._tag) {
    case "Name": {
      const def = env.definitions.get(expr.name)
      return def ? memberPlaces(def.expr, env, depth + 1) : []
    }
    case "Members":
      return placesOf(expr.place, depth + 1)
    case "Or":
    case "And":
      return [...memberPlaces(expr.left, env, depth + 1), ...memberPlaces(expr.right, env, depth + 1)]
    case "In":
      return [...memberPlaces(expr.who, env, depth + 1), ...memberPlaces(expr.where, env, depth + 1)]
    default:
      return []
  }
}
