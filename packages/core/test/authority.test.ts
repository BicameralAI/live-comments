import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { compile, type Evidence, expand, judge, makeEnv } from "../src/authority/evaluate.js"
import { parseAuthorityFile } from "../src/authority/file.js"
import { And, Anyone, type Expr, In, Literal, Members, Name, Or, parseExpression, print } from "../src/authority/syntax.js"

const name = fc.constantFrom("pricing", "legal", "jdoe", "pricing-call", "a.b")
const literal = fc.constantFrom(Literal("github", "jdoe"), Literal("linear", "team/PRICING"), Literal("github", "acme/shop#12"))
const people: fc.Arbitrary<Expr> = fc.letrec<{ p: Expr }>((tie) => ({
  p: fc.oneof(
    { depthSize: "small" },
    name.map(Name),
    literal,
    fc.constant(Anyone),
    literal.map(Members),
    fc.tuple(tie("p"), tie("p")).map(([l, r]) => Or(l, r))
  )
})).p
const place: fc.Arbitrary<Expr> = fc.oneof(name.map(Name), literal)
const expr: fc.Arbitrary<Expr> = fc.letrec<{ e: Expr }>((tie) => ({
  e: fc.oneof(
    { depthSize: "small" },
    people,
    fc.tuple(people, place).map(([w, p]) => In(w, p)),
    fc.tuple(tie("e"), tie("e")).map(([l, r]) => Or(l, r)),
    fc.tuple(tie("e"), tie("e")).map(([l, r]) => And(l, r))
  )
})).e

describe("syntax", () => {
  it("prints expressions that parse back to themselves", () => {
    fc.assert(fc.property(expr, (e) => {
      expect(parseExpression(print(e))).toEqual(e)
    }))
  })

  it("binds in tighter than &, and & tighter than |", () => {
    expect(parseExpression("a | b & c in d")).toEqual(Or(Name("a"), And(Name("b"), In(Name("c"), Name("d")))))
  })

  it("keeps # inside refs", () => {
    expect(parseExpression("jin in github:BicameralAI/bicameral#12")).toEqual(In(Name("jin"), Literal("github", "BicameralAI/bicameral#12")))
  })
})

describe("authority file", () => {
  const file = `
# People
jdoe   = github:jdoe | linear:usr_1 | email:jdoe@acme.com
mlee   = github:mlee
agent claude = github:acme-claude[bot]
pricing = jdoe | mlee      # the pricing team
legal   = members(linear:team/LEGAL)
pricing-desk = linear:team/PRICING | github:acme/shop
pricing-call = pricing in pricing-desk
launch-call  = pricing-call & legal
`

  it("parses definitions and agents", () => {
    const f = parseAuthorityFile(file)
    expect(f.problems).toEqual([])
    expect(f.definitions.map((d) => d.name)).toEqual(["jdoe", "mlee", "claude", "pricing", "legal", "pricing-desk", "pricing-call", "launch-call"])
    expect(f.definitions.find((d) => d.name === "claude")?.agent).toBe(true)
  })

  it("reports duplicates and cycles", () => {
    const f = parseAuthorityFile("a = b\nb = c | a\na = github:x\nc = github:y")
    expect(f.problems.map((p) => p.kind).sort()).toEqual(["cycle", "duplicate"])
  })

  it("reports syntax errors with line numbers", () => {
    const f = parseAuthorityFile("ok = github:x\nbroken = (a | b\n")
    expect(f.problems).toEqual([{ kind: "syntax", line: 2, message: "expected ')'" }])
  })

  const env = makeEnv(parseAuthorityFile(file), { "linear:team/LEGAL": { retrievedAt: "t", accounts: ["linear:usr_9"] } })
  const ev = (account: string, ref: string, container: string, extra: Partial<Evidence> = {}): Evidence => {
    const [system, acct] = [account.slice(0, account.indexOf(":")), account.slice(account.indexOf(":") + 1)]
    return { author: { system: system!, account: acct! }, source: { ref, container }, annotation: 0, ...extra }
  }
  const verdict = (text: string, evidence: ReadonlyArray<Evidence>) => judge(compile(parseExpression(text), env), evidence, env)

  it("follows a person's accounts across systems", () => {
    expect(verdict("pricing", [ev("linear:usr_1", "linear:ENG-1", "team/ENG")]).ok).toBe(true)
    expect(verdict("pricing", [ev("github:eve", "github:acme/shop#1", "acme/shop")]).ok).toBe(false)
  })

  it("checks where the words were written", () => {
    expect(verdict("pricing-call", [ev("github:jdoe", "github:acme/shop#4", "acme/shop")]).ok).toBe(true)
    expect(verdict("pricing-call", [ev("github:jdoe", "github:acme/other#4", "acme/other")]).ok).toBe(false)
    expect(verdict("pricing-call", [ev("linear:usr_1", "linear:ENG-9", "team/PRICING")]).ok).toBe(true)
  })

  it("needs words from both sides of &", () => {
    const pm = ev("github:jdoe", "github:acme/shop#4", "acme/shop")
    const lawyer = ev("linear:usr_9", "linear:LEG-1", "team/LEGAL")
    expect(verdict("launch-call", [pm]).ok).toBe(false)
    expect(verdict("launch-call", [pm]).unmet).toEqual(["legal"])
    expect(verdict("launch-call", [pm, lawyer]).ok).toBe(true)
  })

  it("fails when any quoted author is unauthorized", () => {
    const j = verdict("pricing", [ev("github:jdoe", "github:acme/shop#1", "acme/shop"), ev("github:eve", "github:acme/shop#1", "acme/shop")])
    expect(j.ok).toBe(false)
    expect(j.unauthorized.map((e) => e.author?.account)).toEqual(["eve"])
  })

  it("never lets agents or bots satisfy anything, even through anyone", () => {
    expect(verdict("anyone", [ev("github:acme-claude[bot]", "github:acme/shop#1", "acme/shop")]).ok).toBe(false)
    expect(verdict("claude", [ev("github:acme-claude[bot]", "github:acme/shop#1", "acme/shop")]).ok).toBe(false)
    expect(verdict("anyone", [ev("github:someone", "github:acme/shop#1", "acme/shop", { bot: true })]).ok).toBe(false)
    expect(verdict("anyone", [ev("github:someone", "github:acme/shop#1", "acme/shop")]).ok).toBe(true)
  })

  it("reports unknown names and misused places", () => {
    expect(compile(parseExpression("nobody"), env).problems.map((p) => p.kind)).toEqual(["unknown-name"])
    expect(compile(parseExpression("pricing in pricing-call"), env).problems.map((p) => p.kind)).toContain("not-a-place")
  })

  it("expands names into people and places", () => {
    const x = expand(parseExpression("pricing-call"), env)
    expect(x.alternatives).toEqual([
      [{ people: ["email:jdoe@acme.com", "github:jdoe", "github:mlee", "linear:usr_1"], places: ["linear:team/PRICING", "github:acme/shop"] }]
    ])
  })

  it("is monotone in evidence for expressions without unauthorized authors", () => {
    // Adding authorized evidence never turns a passing judgement into a failing one.
    const pool = [
      ev("github:jdoe", "github:acme/shop#4", "acme/shop"),
      ev("linear:usr_9", "linear:LEG-1", "team/LEGAL"),
      ev("github:mlee", "linear:X-1", "team/PRICING")
    ]
    fc.assert(
      fc.property(fc.subarray(pool), fc.subarray(pool), fc.constantFrom("pricing", "pricing-call", "launch-call", "legal | pricing"), (a, b, text) => {
        const c = compile(parseExpression(text), env)
        const small = judge(c, a, env)
        const big = judge(c, [...a, ...b.filter((x) => !a.includes(x))], env)
        return !small.ok || big.ok || big.unauthorized.length > 0
      })
    )
  })
})
