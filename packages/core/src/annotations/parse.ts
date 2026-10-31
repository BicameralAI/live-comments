import ts from "typescript"
import { Anyone, type Expr, In, parseExpr, SyntaxError, type Token, TokenStream, tokenize } from "../authority/syntax.js"

// Live comments in TypeScript source (spec §4): `@source` and `@open` tags in
// the JSDoc block above a top-level declaration.

export interface SourceAnnotation {
  readonly kind: "source"
  readonly line: number
  readonly ref: string
  readonly quote?: string
  /** `by …`, with any `in …` folded in. */
  readonly authority?: Expr
  readonly raw: string
}

export interface OpenAnnotation {
  readonly kind: "open"
  readonly line: number
  readonly id?: string
  readonly question: string
  readonly by?: Expr
  readonly in?: Expr
  /** `by` and `in` combined: `by in in`, or `anyone in …` when only `in` is given. */
  readonly authority?: Expr
  readonly options: ReadonlyArray<string>
  readonly raw: string
}

export type Annotation = SourceAnnotation | OpenAnnotation

export interface Declaration {
  readonly file: string
  readonly name: string
  readonly line: number
  readonly exported: boolean
  readonly annotations: ReadonlyArray<Annotation>
}

export const declarationKey = (d: { file: string; name: string }): string => `${d.file}#${d.name}`

export interface ParseProblem {
  readonly file: string
  readonly line: number
  readonly message: string
}

export interface ParsedFile {
  readonly file: string
  readonly declarations: ReadonlyArray<Declaration>
  readonly problems: ReadonlyArray<ParseProblem>
}

// ---------------------------------------------------------------------------
// Tag bodies

/** Index of the first top-level occurrence of one of `keywords`, or the end. */
const findKeyword = (tokens: ReadonlyArray<Token>, from: number, keywords: ReadonlyArray<string>): number => {
  let depth = 0
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.kind === "op" && t.value === "(") depth++
    else if (t.kind === "op" && t.value === ")") depth--
    else if (depth === 0 && t.kind === "ident" && keywords.includes(t.value)) return i
  }
  return tokens.length
}

const parseSlice = (tokens: ReadonlyArray<Token>, from: number, to: number, end: number, what: string): Expr => {
  if (from >= to) throw new SyntaxError(`expected an expression after '${what}'`, tokens[from - 1]?.pos ?? 0)
  const ts = new TokenStream(tokens.slice(from, to), tokens[to]?.pos ?? end)
  const e = parseExpr(ts)
  if (ts.peek()) throw new SyntaxError(`unexpected input in '${what}' clause`, ts.pos())
  return e
}

const combine = (by: Expr | undefined, inn: Expr | undefined): Expr | undefined =>
  by && inn ? In(by, inn) : by ? by : inn ? In(Anyone, inn) : undefined

export const parseSourceBody = (body: string, line: number): SourceAnnotation => {
  const tokens = tokenize(body)
  const first = tokens[0]
  if (first?.kind !== "literal") throw new SyntaxError("@source needs a ref such as linear:ENG-142", first?.pos ?? 0)
  let i = 1
  let quote: string | undefined
  const q = tokens[i]
  if (q?.kind === "string") {
    quote = q.value
    i++
  }
  let by: Expr | undefined
  let inn: Expr | undefined
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t.kind === "ident" && t.value === "by" && !by) {
      const stop = findKeyword(tokens, i + 1, ["in"])
      by = parseSlice(tokens, i + 1, stop, body.length, "by")
      i = stop
    } else if (t.kind === "ident" && t.value === "in" && !inn) {
      const stop = findKeyword(tokens, i + 1, ["by"])
      inn = parseSlice(tokens, i + 1, stop, body.length, "in")
      i = stop
    } else {
      throw new SyntaxError("expected 'by' or 'in'", t.pos)
    }
  }
  const authority = combine(by, inn)
  return {
    kind: "source",
    line,
    ref: `${first.system}:${first.path}`,
    ...(quote !== undefined ? { quote } : {}),
    ...(authority ? { authority } : {}),
    raw: body
  }
}

export const parseOpenBody = (body: string, line: number): OpenAnnotation => {
  const tokens = tokenize(body)
  let i = 0
  let id: string | undefined
  const first = tokens[0]
  if (first?.kind === "ident" && !["by", "in", "options"].includes(first.value)) {
    id = first.value
    i++
  } else if (first?.kind === "literal") {
    // An id may contain a colon-free dotted path only; a literal here is a mistake.
    throw new SyntaxError("an @open id cannot contain ':'", first.pos)
  }
  const q = tokens[i]
  if (q?.kind !== "string") throw new SyntaxError('@open needs a question in double quotes', q?.pos ?? body.length)
  i++
  let by: Expr | undefined
  let inn: Expr | undefined
  const options: Array<string> = []
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t.kind === "ident" && t.value === "by" && !by) {
      const stop = findKeyword(tokens, i + 1, ["in", "options"])
      by = parseSlice(tokens, i + 1, stop, body.length, "by")
      i = stop
    } else if (t.kind === "ident" && t.value === "in" && !inn) {
      const stop = findKeyword(tokens, i + 1, ["by", "options"])
      inn = parseSlice(tokens, i + 1, stop, body.length, "in")
      i = stop
    } else if (t.kind === "ident" && t.value === "options" && options.length === 0) {
      i++
      for (;;) {
        const s = tokens[i]
        if (s?.kind !== "string") throw new SyntaxError('expected an option in double quotes', s?.pos ?? body.length)
        options.push(s.value)
        i++
        const sep = tokens[i]
        if (sep?.kind === "op" && sep.value === "|") i++
        else break
      }
    } else {
      throw new SyntaxError("expected 'by', 'in' or 'options'", t.pos)
    }
  }
  const authority = combine(by, inn)
  return {
    kind: "open",
    line,
    ...(id ? { id } : {}),
    question: q.value,
    ...(by ? { by } : {}),
    ...(inn ? { in: inn } : {}),
    ...(authority ? { authority } : {}),
    options,
    raw: body
  }
}

// ---------------------------------------------------------------------------
// JSDoc blocks

interface RawTag {
  readonly name: string
  readonly body: string
  readonly line: number
}

/** Extract `@name body` tags from a `/** … *\/` comment, with continuation lines joined. */
export const extractTags = (comment: string, startLine: number): ReadonlyArray<RawTag> => {
  const inner = comment.replace(/^\/\*\*/, "").replace(/\*\/$/, "")
  const lines = inner.split(/\r?\n/)
  const tags: Array<{ name: string; body: string; line: number }> = []
  lines.forEach((raw, idx) => {
    const text = raw.replace(/^\s*\*?\s?/, "")
    const m = /^@(\w+)\s*(.*)$/.exec(text.trim())
    if (m) tags.push({ name: m[1]!, body: m[2]!, line: startLine + idx })
    else if (tags.length > 0 && text.trim().length > 0) tags[tags.length - 1]!.body += " " + text.trim()
  })
  return tags.map((t) => ({ ...t, body: t.body.trim() }))
}

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

const declarationName = (stmt: ts.Statement): string | undefined => {
  if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) return stmt.name?.text ?? "default"
  if (ts.isVariableStatement(stmt)) {
    const d = stmt.declarationList.declarations[0]
    return d && ts.isIdentifier(d.name) ? d.name.text : undefined
  }
  if (ts.isEnumDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) return stmt.name.text
  return undefined
}

/** Parse every top-level declaration in a TypeScript or JavaScript file. */
export const parseFile = (file: string, text: string): ParsedFile => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const declarations: Array<Declaration> = []
  const problems: Array<ParseProblem> = []
  for (const stmt of sf.statements) {
    const name = declarationName(stmt)
    if (!name) continue
    const annotations: Array<Annotation> = []
    for (const range of ts.getLeadingCommentRanges(text, stmt.pos) ?? []) {
      const comment = text.slice(range.pos, range.end)
      if (!comment.startsWith("/**")) continue
      const startLine = sf.getLineAndCharacterOfPosition(range.pos).line + 1
      for (const tag of extractTags(comment, startLine)) {
        if (tag.name !== "source" && tag.name !== "open") continue
        try {
          annotations.push(tag.name === "source" ? parseSourceBody(tag.body, tag.line) : parseOpenBody(tag.body, tag.line))
        } catch (e) {
          if (e instanceof SyntaxError) problems.push({ file, line: tag.line, message: `@${tag.name}: ${e.message}` })
          else throw e
        }
      }
    }
    declarations.push({
      file,
      name,
      line: sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1,
      exported: isExported(stmt),
      annotations
    })
  }
  return { file, declarations, problems }
}
