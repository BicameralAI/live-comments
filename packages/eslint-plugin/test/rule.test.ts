import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Linter } from "eslint"
import tseslint from "typescript-eslint"
import { describe, expect, it } from "vitest"
import plugin from "../src/index.js"

describe("live-comments/check", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lc-eslint-"))
  writeFileSync(path.join(dir, "live-comments.config.json"), JSON.stringify({ governed: ["src/**"], resolvers: { file: { builtin: "file" } } }))
  writeFileSync(path.join(dir, "AUTHORITY"), "pat = email:pat@acme.com\n")

  const lint = (code: string) =>
    new Linter({ configType: "flat", cwd: dir }).verify(
      code,
      [{ files: ["**/*.ts"], languageOptions: { parser: tseslint.parser as Linter.Parser }, plugins: { "live-comments": plugin as never }, rules: { "live-comments/check": "error" } }],
      path.join(dir, "src", "a.ts")
    )

  it("reports file-local problems at their lines", () => {
    const messages = lint(`export const a = 1\n\n/** @source file:docs/x.md by nobody */\nexport const b = 2\n`)
    expect(messages.map((m) => [m.line, m.message.slice(0, 5)])).toEqual([
      [1, "LC004"],
      [3, "LC003"]
    ])
  })

  it("is quiet for annotated code", () => {
    expect(lint(`/** @open "Is this right?" */\nexport const a = 1\n`)).toEqual([])
  })
})
