// Authority expressions (spec §7.2) and the shared tokenizer used by both the
// AUTHORITY file and inline `by` / `in` clauses.

export type Expr =
  | { readonly _tag: "Name"; readonly name: string }
  | { readonly _tag: "Literal"; readonly system: string; readonly path: string }
  | { readonly _tag: "Anyone" }
  | { readonly _tag: "Members"; readonly place: Expr }
  | { readonly _tag: "Or"; readonly left: Expr; readonly right: Expr }
  | { readonly _tag: "And"; readonly left: Expr; readonly right: Expr }
  | { readonly _tag: "In"; readonly who: Expr; readonly where: Expr }

export const Name = (name: string): Expr => ({ _tag: "Name", name })
export const Literal = (system: string, path: string): Expr => ({ _tag: "Literal", system, path })
export const Anyone: Expr = { _tag: "Anyone" }
export const Members = (place: Expr): Expr => ({ _tag: "Members", place })
export const Or = (left: Expr, right: Expr): Expr => ({ _tag: "Or", left, right })
export const And = (left: Expr, right: Expr): Expr => ({ _tag: "And", left, right })
export const In = (who: Expr, where: Expr): Expr => ({ _tag: "In", who, where })

// ---------------------------------------------------------------------------
// Tokens

export type Token =
  | { readonly kind: "string"; readonly value: string; readonly pos: number }
  | { readonly kind: "literal"; readonly system: string; readonly path: string; readonly pos: number }
  | { readonly kind: "ident"; readonly value: string; readonly pos: number }
  | { readonly kind: "op"; readonly value: "|" | "&" | "(" | ")" | "="; readonly pos: number }

export const KEYWORDS = new Set(["by", "in", "options", "members", "anyone", "agent"])

export class SyntaxError extends Error {
  constructor(message: string, readonly pos: number) {
    super(message)
  }
}

const LITERAL = /^([A-Za-z][\w+.-]*):([^\s|&(),"=]+)/
const IDENT = /^[A-Za-z_][\w.-]*/

export const tokenize = (src: string): ReadonlyArray<Token> => {
  const out: Array<Token> = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '"') {
      let j = i + 1
      let value = ""
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          value += src[j + 1]
          j += 2
        } else {
          value += src[j]
          j++
        }
      }
      if (j >= src.length) throw new SyntaxError("unterminated string", i)
      out.push({ kind: "string", value, pos: i })
      i = j + 1
      continue
    }
    if (c === "|" || c === "&" || c === "(" || c === ")" || c === "=") {
      out.push({ kind: "op", value: c, pos: i })
      i++
      continue
    }
    const rest = src.slice(i)
    const lit = LITERAL.exec(rest)
    if (lit) {
      out.push({ kind: "literal", system: lit[1]!, path: lit[2]!, pos: i })
      i += lit[0].length
      continue
    }
    const id = IDENT.exec(rest)
    if (id) {
      out.push({ kind: "ident", value: id[0], pos: i })
      i += id[0].length
      continue
    }
    throw new SyntaxError(`unexpected character '${c}'`, i)
  }
  return out
}

// ---------------------------------------------------------------------------
// Parser. Precedence, loosest first: `|`, `&`, `in`.

export class TokenStream {
  i = 0
  constructor(readonly tokens: ReadonlyArray<Token>, readonly end: number) {}
  peek(): Token | undefined {
    return this.tokens[this.i]
  }
  next(): Token | undefined {
    return this.tokens[this.i++]
  }
  atKeyword(k: string): boolean {
    const t = this.peek()
    return t?.kind === "ident" && t.value === k
  }
  atOp(op: string): boolean {
    const t = this.peek()
    return t?.kind === "op" && t.value === op
  }
  pos(): number {
    return this.peek()?.pos ?? this.end
  }
}

/** Keywords that end an expression inside an inline tag. */
const STOP = new Set(["options"])

export const parseExpr = (ts: TokenStream): Expr => parseOr(ts)

const parseOr = (ts: TokenStream): Expr => {
  let left = parseAnd(ts)
  while (ts.atOp("|")) {
    ts.next()
    left = Or(left, parseAnd(ts))
  }
  return left
}

const parseAnd = (ts: TokenStream): Expr => {
  let left = parseIn(ts)
  while (ts.atOp("&")) {
    ts.next()
    left = And(left, parseIn(ts))
  }
  return left
}

const parseIn = (ts: TokenStream): Expr => {
  const who = parseAtom(ts)
  if (ts.atKeyword("in")) {
    ts.next()
    return In(who, parseAtom(ts))
  }
  return who
}

const parseAtom = (ts: TokenStream): Expr => {
  const t = ts.next()
  if (!t) throw new SyntaxError("expected a name, account or place", ts.end)
  if (t.kind === "op" && t.value === "(") {
    const e = parseOr(ts)
    if (!ts.atOp(")")) throw new SyntaxError("expected ')'", ts.pos())
    ts.next()
    return e
  }
  if (t.kind === "literal") return Literal(t.system, t.path)
  if (t.kind === "ident") {
    if (t.value === "anyone") return Anyone
    if (t.value === "members") {
      if (!ts.atOp("(")) throw new SyntaxError("expected '(' after members", ts.pos())
      ts.next()
      const place = parseOr(ts)
      if (!ts.atOp(")")) throw new SyntaxError("expected ')'", ts.pos())
      ts.next()
      return Members(place)
    }
    if (KEYWORDS.has(t.value) || STOP.has(t.value)) throw new SyntaxError(`unexpected keyword '${t.value}'`, t.pos)
    return Name(t.value)
  }
  throw new SyntaxError("expected a name, account or place", t.pos)
}

/** Parse a whole string as one expression. */
export const parseExpression = (src: string): Expr => {
  const ts = new TokenStream(tokenize(src), src.length)
  const e = parseExpr(ts)
  if (ts.peek()) throw new SyntaxError("unexpected input after expression", ts.pos())
  return e
}

// ---------------------------------------------------------------------------
// Printer. Canonical form, used for comparisons and sticky arguments.

const prec = (e: Expr): number => (e._tag === "Or" ? 1 : e._tag === "And" ? 2 : e._tag === "In" ? 3 : 4)

export const print = (e: Expr): string => {
  const wrap = (child: Expr, min: number) => (prec(child) < min ? `(${print(child)})` : print(child))
  switch (e._tag) {
    case "Name":
      return e.name
    case "Literal":
      return `${e.system}:${e.path}`
    case "Anyone":
      return "anyone"
    case "Members":
      return `members(${print(e.place)})`
    case "Or":
      return `${wrap(e.left, 1)} | ${wrap(e.right, 2)}`
    case "And":
      return `${wrap(e.left, 2)} & ${wrap(e.right, 3)}`
    case "In":
      return `${wrap(e.who, 4)} in ${wrap(e.where, 4)}`
  }
}

/** Names an expression refers to directly. */
export const namesIn = (e: Expr): ReadonlyArray<string> => {
  switch (e._tag) {
    case "Name":
      return [e.name]
    case "Literal":
    case "Anyone":
      return []
    case "Members":
      return namesIn(e.place)
    case "Or":
    case "And":
      return [...namesIn(e.left), ...namesIn(e.right)]
    case "In":
      return [...namesIn(e.who), ...namesIn(e.where)]
  }
}
