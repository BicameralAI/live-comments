import fc from "fast-check"
import { describe, it } from "vitest"
import { parseFile } from "../src/annotations/parse.js"
import { emptyLock, type Lock } from "../src/domain.js"
import { evaluate } from "../src/lifecycle/evaluate.js"
import { normalizeText } from "../src/normalize.js"
import { planSync } from "../src/workflows/commands.js"
import type { Workspace } from "../src/workflows/workspace.js"
import { type FakeComment, githubFixture, withFixture, workspace } from "./helpers.js"

// Model-based test of the comment lifecycle. A random sequence of events edits
// a GitHub issue, changes group membership, edits the quote in code, and syncs.
// After every step, the checker's status for the @source must match a small
// reference model that computes the expected status directly from the world
// as it was at the last sync.

const PHRASES = ["codes do not stack", "codes stack", "do not stack", "best single discount wins"]
const PEOPLE = ["jdoe", "kim", "eve", "ci-bot"]
const AUTHORITY = "jdoe = github:jdoe\npricing = jdoe | members(github:acme)\n"

interface World {
  body: string
  comments: Array<FakeComment>
  org: Array<string>
  quote: string
  nextId: number
}

interface Real {
  ws: Workspace
  lock: Lock
}

interface Model {
  world: World
  /** The world as of the last sync, or undefined before the first sync. */
  synced: { body: string; comments: ReadonlyArray<FakeComment>; org: ReadonlyArray<string> } | undefined
}

const code = (quote: string) => `/** @source github:acme/shop#1 "${quote}" by pricing */\nexport const applyDiscounts = 1\n`

/** Reference model: expected status, computed without the checker's spans or judge. */
const expected = (m: Model): string => {
  if (!m.synced) return "unlocked"
  const segments = [
    { text: "Discounts", author: "jdoe" },
    { text: m.synced.body, author: "jdoe" },
    ...m.synced.comments.map((c) => ({ text: c.body, author: c.login }))
  ]
    .map((s) => ({ ...s, text: normalizeText(s.text) }))
    .filter((s) => s.text.length > 0)
  const text = segments.map((s) => s.text).join(" ")
  const q = normalizeText(m.world.quote)
  const at = text.indexOf(q)
  if (at === -1) return "misquoted"
  // Authors of every segment the first occurrence touches.
  let offset = 0
  const authors: Array<string> = []
  for (const s of segments) {
    const start = offset
    const end = offset + s.text.length
    if (start < at + q.length && end > at) authors.push(s.author)
    offset = end + 1
  }
  const allowed = new Set(["jdoe", ...m.synced.org])
  return authors.every((a) => a !== "ci-bot" && allowed.has(a)) ? "authorized" : "unauthorized"
}

const fixtureFor = (w: World) =>
  githubFixture(
    [{ owner: "acme", repo: "shop", number: 1, login: "jdoe", title: "Discounts", body: w.body, comments: w.comments.map((c) => ({ ...c, bot: c.login === "ci-bot" })) }],
    { acme: w.org }
  )

const status = (r: Real) => evaluate({ ...r.ws, lock: r.lock }).annotations[0]!.status

type Cmd = fc.AsyncCommand<Model, Real>

const step = (name: string, apply: (m: Model) => void, run?: (m: Model, r: Real) => Promise<void>): Cmd => ({
  check: () => true,
  run: async (m, r) => {
    apply(m)
    await run?.(m, r)
    const got = status(r)
    const want = expected(m)
    if (got !== want) throw new Error(`after ${name}: checker says ${got}, model says ${want}`)
  },
  toString: () => name
})

const commands = [
  fc.constantFrom(...PHRASES).map((p) => step(`SetBody(${p})`, (m) => void (m.world.body = p))),
  fc.tuple(fc.constantFrom(...PEOPLE), fc.constantFrom(...PHRASES)).map(([who, p]) =>
    step(`Comment(${who}: ${p})`, (m) => void m.world.comments.push({ id: m.world.nextId++, login: who, body: p }))
  ),
  fc.nat(5).map((i) => step(`DeleteComment(${i})`, (m) => void m.world.comments.splice(i % Math.max(1, m.world.comments.length), 1))),
  fc.constantFrom("kim", "eve", "ci-bot").map((who) =>
    step(`Join(${who})`, (m) => void (m.world.org.includes(who) || m.world.org.push(who)))
  ),
  fc.constantFrom("kim", "eve", "ci-bot").map((who) => step(`Leave(${who})`, (m) => void (m.world.org = m.world.org.filter((x) => x !== who)))),
  fc.constantFrom(...PHRASES).map((p) =>
    step(`SetQuote(${p})`, (m) => void (m.world.quote = p), async (m, r) => {
      r.ws = { ...r.ws, files: [parseFile("src/a.ts", code(m.world.quote))] }
    })
  ),
  fc.constant(
    step(
      "Sync",
      (m) => void (m.synced = { body: m.world.body, comments: [...m.world.comments], org: [...m.world.org] }),
      async (m, r) => {
        const result = await withFixture({ ...r.ws, lock: r.lock }, fixtureFor(m.world), planSync({ ...r.ws, lock: r.lock }))
        r.lock = result.lock
      }
    )
  )
]

describe("comment lifecycle (model-based)", () => {
  it("matches the reference model for any sequence of edits, membership changes and syncs", async () => {
    await fc.assert(
      fc.asyncProperty(fc.commands(commands, { maxCommands: 40, size: "large" }), async (cmds) => {
        const world: World = { body: PHRASES[3]!, comments: [], org: [], quote: PHRASES[0]!, nextId: 1 }
        const model: Model = { world, synced: undefined }
        const real: Real = { ws: workspace({ files: { "src/a.ts": code(world.quote) }, authority: AUTHORITY }), lock: emptyLock }
        await fc.asyncModelRun(() => ({ model, real }), cmds)
      }),
      { numRuns: 300 }
    )
  })
})
