import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { beforeAll, describe, expect, it } from "vitest"

// End-to-end through the built CLI, in a throwaway git repository, using the
// built-in `file` source so no network is needed. Run `pnpm build` first.

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "main.js")
const run = (dir: string, ...args: Array<string>) => {
  const r = spawnSync(process.execPath, [cli, ...args, "--root", dir], { encoding: "utf8" })
  return { code: r.status, out: r.stdout + r.stderr }
}
const git = (dir: string, ...args: Array<string>) => execFileSync("git", args, { cwd: dir, encoding: "utf8" })
const commitAs = (dir: string, who: string, email: string, msg: string) =>
  execFileSync("git", ["-c", `user.name=${who}`, "-c", `user.email=${email}`, "commit", "-qam", msg], { cwd: dir })

describe("live-comments CLI", () => {
  let dir = ""

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lc-e2e-"))
    git(dir, "init", "-q")
    mkdirSync(path.join(dir, ".claude"))
    mkdirSync(path.join(dir, "docs"))
    mkdirSync(path.join(dir, "src"))
    writeFileSync(path.join(dir, "docs", "pricing.md"), "# Pricing\n\nOnly the best single discount applies per order.\n")
    writeFileSync(path.join(dir, "docs", "questions.md"), "# Open questions\n")
    git(dir, "add", ".")
    commitAs(dir, "Pat PM", "pat@acme.com", "pricing policy")
  })

  it("init scaffolds config, AUTHORITY, the skill and MCP setup", () => {
    const r = run(dir, "init")
    expect(r.code).toBe(0)
    for (const f of ["live-comments.config.json", "AUTHORITY", ".agents/skills/live-comments/SKILL.md", ".claude/skills/live-comments/SKILL.md", ".mcp.json"]) {
      expect(existsSync(path.join(dir, f)), f).toBe(true)
    }
    expect(JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8")).mcpServers["live-comments"].args).toContain("mcp")
  })

  it("verifies a quote, its author, and reports an open question", () => {
    writeFileSync(path.join(dir, "AUTHORITY"), "pat = email:pat@acme.com\npricing = pat\n")
    const config = JSON.parse(readFileSync(path.join(dir, "live-comments.config.json"), "utf8"))
    writeFileSync(path.join(dir, "live-comments.config.json"), JSON.stringify({ ...config, governed: ["src/**"] }, null, 2))
    writeFileSync(
      path.join(dir, "src", "checkout.ts"),
      `/** @source file:docs/pricing.md "Only the best single discount applies per order." by pricing */
export function applyDiscounts() {}

/** @open "Do gift cards stack with discounts?" by pricing in file:docs/questions.md */
export function applyGiftCard() {}

export const unannotated = 1
`
    )
    expect(run(dir, "sync").code).toBe(0)
    const r = run(dir, "check")
    expect(r.out).toContain("LC004") // the unannotated export
    expect(r.out).toContain('LC100 info  open: "Do gift cards stack with discounts?"')
    expect(r.out).not.toContain("LC009")
    expect(r.code).toBe(1)
  })

  it("surfaces an answer candidate, and accepts the flip to @source", () => {
    writeFileSync(path.join(dir, "docs", "questions.md"), "# Open questions\n\nGift cards apply after discounts and never stack.\n")
    commitAs(dir, "Pat PM", "pat@acme.com", "answer gift card question")
    run(dir, "sync")
    expect(run(dir, "check").out).toContain('LC019 info  possible answer in file:docs/questions.md by email:pat@acme.com: "Gift cards apply after discounts and never stack."')

    const code = readFileSync(path.join(dir, "src", "checkout.ts"), "utf8")
      .replace(
        '/** @open "Do gift cards stack with discounts?" by pricing in file:docs/questions.md */',
        '/** @source file:docs/questions.md "Gift cards apply after discounts and never stack." by pricing in file:docs/questions.md */'
      )
      .replace("export const unannotated = 1\n", "")
    writeFileSync(path.join(dir, "src", "checkout.ts"), code)
    const r = run(dir, "check")
    expect(r.out).toContain("0 error(s)")
    expect(r.code).toBe(0)
  })

  it("flags words from someone without authority, and stale quotes after sync", () => {
    git(dir, "add", ".")
    commitAs(dir, "Pat PM", "pat@acme.com", "annotate")
    writeFileSync(path.join(dir, "docs", "pricing.md"), "# Pricing\n\nDiscounts stack, up to three per order.\n")
    commitAs(dir, "Eve Eng", "eve@acme.com", "edit policy")
    const s = run(dir, "sync")
    expect(s.out).toContain("LC006")
    expect(s.out).toContain("changed  file:docs/pricing.md")
    expect(run(dir, "check").code).toBe(1)
  })

  it("reports authority changes against the base branch", () => {
    git(dir, "add", ".")
    commitAs(dir, "Pat PM", "pat@acme.com", "base")
    const code = readFileSync(path.join(dir, "src", "checkout.ts"), "utf8").replace(
      '"Gift cards apply after discounts and never stack." by pricing in file:docs/questions.md',
      '"Gift cards apply after discounts and never stack." by pat'
    )
    writeFileSync(path.join(dir, "src", "checkout.ts"), code)
    expect(run(dir, "check", "--base", "HEAD").out).toContain("LC016 info  authority changed on 'applyGiftCard'")
  })

  it("serves the read path and facts over MCP", async () => {
    const client = new Client({ name: "test", version: "0" })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--root", dir] }))
    const tools = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(tools).toEqual(["authority", "context", "directory", "read_source", "who"])
    const res = (await client.callTool({ name: "read_source", arguments: { ref: "file:docs/questions.md" } })) as { content: Array<{ text: string }> }
    expect(res.content[0]!.text).toContain("[email:pat@acme.com]")
    await client.close()
  })
})
