import { describe, expect, it } from "vitest"
import { parseFile } from "../src/annotations/parse.js"
import { compareCode } from "../src/lifecycle/compare.js"
import { evaluate } from "../src/lifecycle/evaluate.js"
import { planSync } from "../src/workflows/commands.js"
import { codes, config, type FakeIssue, githubFixture, withFixture, workspace } from "./helpers.js"

const AUTHORITY = `
jdoe    = github:jdoe
eve     = github:eve
pricing = jdoe | members(github:acme)
agent claude = github:acme-claude
`

const issue = (over: Partial<FakeIssue> = {}): FakeIssue => ({
  owner: "acme",
  repo: "shop",
  number: 1,
  login: "jdoe",
  title: "Discount rules",
  body: "Only the best **single** discount applies per order.",
  comments: [],
  ...over
})

const CODE = `
/** @source github:acme/shop#1 "Only the best single discount applies per order." by pricing */
export function applyDiscounts() {}
`

/** Sync a workspace against fixtures, then evaluate with the new lockfile. */
const synced = async (files: Record<string, string>, issues: ReadonlyArray<FakeIssue>, orgs: Record<string, ReadonlyArray<string>> = { acme: [] }, authority = AUTHORITY) => {
  const ws = workspace({ files, authority })
  const r = await withFixture(ws, githubFixture(issues, orgs), planSync(ws))
  return { ws: { ...ws, lock: r.lock }, result: r }
}

describe("a @source", () => {
  it("is authorized when its quote is present and its author satisfies by", async () => {
    const { ws } = await synced({ "src/a.ts": CODE }, [issue()])
    const ev = evaluate(ws)
    expect(ev.annotations.map((a) => a.status)).toEqual(["authorized"])
    expect(codes(ev.diagnostics)).toEqual([])
  })

  it("is unlocked before the first sync", () => {
    const ev = evaluate(workspace({ files: { "src/a.ts": CODE }, authority: AUTHORITY }))
    expect(codes(ev.diagnostics)).toContain("LC003")
  })

  it("is bound by its ref alone, without quote or by", async () => {
    const { ws } = await synced({ "src/a.ts": "/** @source github:acme/shop#1 */\nexport const x = 1" }, [issue()])
    expect(evaluate(ws).annotations[0]!.status).toBe("bound")
  })

  it("reports a scheme with no resolver", () => {
    const ev = evaluate(workspace({ files: { "src/a.ts": "/** @source notion:abc */\nexport const x = 1" } }))
    expect(codes(ev.diagnostics)).toEqual(["LC018"])
  })

  it("rejects words from someone outside the authority, and from agents", async () => {
    const code = `/** @source github:acme/shop#1 "ship it" by pricing */\nexport const x = 1`
    for (const login of ["eve", "acme-claude"]) {
      const { ws } = await synced({ "src/a.ts": code }, [issue({ comments: [{ id: 1, login, body: "ship it" }] })])
      expect(codes(evaluate(ws).diagnostics)).toContain("LC009")
    }
  })

  it("flags unknown names", async () => {
    const code = `/** @source github:acme/shop#1 by nobody */\nexport const x = 1`
    const { ws } = await synced({ "src/a.ts": code }, [issue()])
    expect(codes(evaluate(ws).diagnostics)).toContain("LC011")
  })
})

describe("lifecycle events", () => {
  it("source updated: a removed quote turns stale", async () => {
    const first = await synced({ "src/a.ts": CODE }, [issue()])
    const r = await withFixture(first.ws, githubFixture([issue({ body: "Discounts stack now.", updated_at: "2026-10-20T00:00:00Z" })], { acme: [] }), planSync(first.ws))
    expect(codes(r.impact.sync)).toEqual(["LC006"])
    expect(r.updated).toEqual(["github:acme/shop#1"])
  })

  it("source updated: same words, new author, re-evaluates by", async () => {
    const code = `/** @source github:acme/shop#1 "approved" by pricing */\nexport const x = 1`
    const first = await synced({ "src/a.ts": code }, [issue({ comments: [{ id: 1, login: "jdoe", body: "approved" }] })])
    expect(codes(evaluate(first.ws).diagnostics)).toEqual([])
    const r = await withFixture(first.ws, githubFixture([issue({ comments: [{ id: 2, login: "eve", body: "approved" }] })], { acme: [] }), planSync(first.ws))
    expect(codes(r.impact.appeared)).toContain("LC009")
  })

  it("source updated: a ref-only citation reports the change", async () => {
    const code = "/** @source github:acme/shop#1 */\nexport const x = 1"
    const first = await synced({ "src/a.ts": code }, [issue()])
    const r = await withFixture(first.ws, githubFixture([issue({ updated_at: "2026-10-21T00:00:00Z" })], { acme: [] }), planSync(first.ws))
    expect(codes(r.impact.sync)).toEqual(["LC014"])
  })

  it("membership changed: leaving the group removes authority", async () => {
    const code = `/** @source github:acme/shop#1 "ok" by pricing */\nexport const x = 1`
    const first = await synced({ "src/a.ts": code }, [issue({ comments: [{ id: 1, login: "kim", body: "ok" }] })], { acme: ["kim"] })
    expect(codes(evaluate(first.ws).diagnostics)).toEqual([])
    const r = await withFixture(first.ws, githubFixture([issue({ comments: [{ id: 1, login: "kim", body: "ok" }] })], { acme: [] }), planSync(first.ws))
    expect(r.membershipChanges).toEqual([{ place: "github:acme", added: [], removed: ["github:kim"] }])
    expect(codes(r.impact.appeared)).toContain("LC009")
  })

  it("authority edited: narrowing a name affects the rules that use it", async () => {
    const first = await synced({ "src/a.ts": CODE }, [issue()])
    const narrowed = { ...first.ws, authority: workspace({ authority: "jdoe = github:jdoe\npricing = github:someone-else" }).authority }
    expect(codes(evaluate(narrowed).diagnostics)).toContain("LC009")
  })

  it("code changed: authority changes are reported against the base", () => {
    const base = [parseFile("src/a.ts", CODE)]
    const head = [parseFile("src/a.ts", CODE.replace("by pricing", "by eve"))]
    const ds = compareCode(base, head, config())
    expect(ds.map((d) => [d.code, d.message])).toEqual([["LC016", "authority changed on 'applyDiscounts': by pricing → by eve"]])
  })

  it("code changed: a fill must keep sticky arguments", () => {
    const base = [parseFile("src/a.ts", `/** @open "Do codes stack?" by pricing in github:acme/shop options "yes" | "no" */\nexport const x = 1`)]
    const kept = [parseFile("src/a.ts", `/** @source github:acme/shop#1 "no" by pricing in github:acme/shop */\nexport const x = 1`)]
    const dropped = [parseFile("src/a.ts", `/** @source github:acme/shop#1 "no" */\nexport const x = 1`)]
    expect(codes(compareCode(base, kept, config()))).toEqual([])
    expect(codes(compareCode(base, dropped, config()))).toEqual(["LC015", "LC016"])
    expect(codes(compareCode(base, dropped, config({ sticky: false })))).toEqual(["LC016"])
  })

  it("config changed: governing an area surfaces unannotated exports", () => {
    const ws = workspace({ files: { "src/billing/tax.ts": "export const rate = 0.2\nconst internal = 1" } })
    expect(codes(evaluate(ws).diagnostics)).toEqual([])
    expect(codes(evaluate({ ...ws, config: config({ governed: ["src/billing/**"] }) }).diagnostics)).toEqual(["LC004"])
  })
})

describe("an @open", () => {
  const OPEN = `/** @open "Do codes stack with gift cards?" by pricing in github:acme/shop#7 */\nexport const giftCard = 1`

  it("is listed with who should answer it", () => {
    const ev = evaluate(workspace({ files: { "src/a.ts": OPEN }, authority: AUTHORITY }))
    expect(ev.diagnostics.filter((d) => d.code === "LC100").map((d) => d.message)).toEqual(['open: "Do codes stack with gift cards?" — to be answered by pricing in github:acme/shop#7'])
    // pricing includes members(github:acme), which has not been synced yet
    expect(codes(ev.diagnostics)).toContain("LC003")
  })

  it("becomes answerable when someone with authority writes in its place, and only then", async () => {
    const thread = (comments: FakeIssue["comments"]) => [issue({ number: 7, login: "eve", body: "Question: do gift cards stack?", comments })]
    const quiet = await synced({ "src/a.ts": OPEN }, thread([{ id: 1, login: "eve", body: "I think yes" }]))
    expect(evaluate(quiet.ws).annotations[0]!.status).toBe("open")

    const answered = await synced({ "src/a.ts": OPEN }, thread([{ id: 2, login: "jdoe", body: "No: gift cards apply after discounts." }]))
    const ev = evaluate(answered.ws)
    expect(ev.annotations[0]!.status).toBe("answerable")
    expect(ev.diagnostics.find((d) => d.code === "LC019")?.message).toContain("No: gift cards apply after discounts.")

    // Flipping it: the @source keeps the sticky arguments and is authorized.
    const flipped = { ...answered.ws, files: [parseFile("src/a.ts", `/** @source github:acme/shop#7 "No: gift cards apply after discounts." by pricing in github:acme/shop#7 */\nexport const giftCard = 1`)] }
    expect(evaluate(flipped).annotations[0]!.status).toBe("authorized")
    expect(codes(compareCode([parseFile("src/a.ts", OPEN)], flipped.files, config()))).toEqual([])
  })
})
