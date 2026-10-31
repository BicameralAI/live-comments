import { type Expr, KEYWORDS, parseExpr, SyntaxError, TokenStream, tokenize } from "./syntax.js"

// The AUTHORITY file (spec §7.1): one definition per line, `[agent] name = expr`.

export interface Definition {
  readonly name: string
  readonly expr: Expr
  readonly agent: boolean
  readonly line: number
}

export interface FileProblem {
  readonly kind: "syntax" | "duplicate" | "cycle"
  readonly line: number
  readonly message: string
}

export interface AuthorityFile {
  readonly definitions: ReadonlyArray<Definition>
  readonly problems: ReadonlyArray<FileProblem>
}

/** `#` starts a comment at the start of a line or after whitespace, so `repo#12` survives. */
const stripComment = (line: string): string => {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i)
  }
  return line
}

export const parseAuthorityFile = (src: string): AuthorityFile => {
  const definitions: Array<Definition> = []
  const problems: Array<FileProblem> = []
  const lines = src.split(/\r?\n/)
  lines.forEach((raw, idx) => {
    const line = idx + 1
    const text = stripComment(raw)
    if (text.trim().length === 0) return
    try {
      const ts = new TokenStream(tokenize(text), text.length)
      let agent = false
      if (ts.atKeyword("agent")) {
        ts.next()
        agent = true
      }
      const nameTok = ts.next()
      if (nameTok?.kind !== "ident" || KEYWORDS.has(nameTok.value)) {
        throw new SyntaxError("expected a name at the start of the definition", nameTok?.pos ?? 0)
      }
      if (!ts.atOp("=")) throw new SyntaxError("expected '='", ts.pos())
      ts.next()
      const expr = parseExpr(ts)
      if (ts.peek()) throw new SyntaxError("unexpected input after expression", ts.pos())
      definitions.push({ name: nameTok.value, expr, agent, line })
    } catch (e) {
      if (e instanceof SyntaxError) problems.push({ kind: "syntax", line, message: e.message })
      else throw e
    }
  })

  const seen = new Map<string, number>()
  for (const d of definitions) {
    const first = seen.get(d.name)
    if (first !== undefined) {
      problems.push({ kind: "duplicate", line: d.line, message: `'${d.name}' is already defined on line ${first}` })
    } else seen.set(d.name, d.line)
  }

  // Cycle detection over name references.
  const byName = new Map<string, Definition>()
  for (const d of definitions) if (!byName.has(d.name)) byName.set(d.name, d)
  const state = new Map<string, "visiting" | "done">()
  const reported = new Set<string>()
  const visit = (name: string, path: ReadonlyArray<string>): void => {
    const d = byName.get(name)
    if (!d) return
    const s = state.get(name)
    if (s === "done") return
    if (s === "visiting") {
      const cycle = [...path.slice(path.indexOf(name)), name]
      const key = [...cycle].sort().join(",")
      if (!reported.has(key)) {
        reported.add(key)
        problems.push({ kind: "cycle", line: d.line, message: `definitions refer to each other in a cycle: ${cycle.join(" → ")}` })
      }
      return
    }
    state.set(name, "visiting")
    for (const n of refs(d.expr)) visit(n, [...path, name])
    state.set(name, "done")
  }
  for (const d of definitions) visit(d.name, [])

  return { definitions, problems }
}

const refs = (e: Expr): ReadonlyArray<string> => {
  switch (e._tag) {
    case "Name":
      return [e.name]
    case "Literal":
    case "Anyone":
      return []
    case "Members":
      return refs(e.place)
    case "Or":
    case "And":
      return [...refs(e.left), ...refs(e.right)]
    case "In":
      return [...refs(e.who), ...refs(e.where)]
  }
}
