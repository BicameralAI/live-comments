import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"
import {
  CONFIG_FILE,
  type Config,
  decodeLock,
  defaultConfig,
  emptyLock,
  evaluate,
  LOCK_FILE,
  parseAuthorityFile,
  parseConfig,
  parseFile
} from "@live-comments/core"
import { Either } from "effect"

// `live-comments/check`: the file-local part of `live-comments check`, shown in
// the editor. It reads only the lockfile, so it is offline and fast. Checks
// that need the whole repository or the base branch stay in the CLI.

interface RuleContext {
  readonly filename: string
  readonly sourceCode: { readonly text: string }
  report(d: { loc: { line: number; column: number }; message: string }): void
}

const findRoot = (file: string): string | undefined => {
  let dir = path.dirname(file)
  for (;;) {
    if (existsSync(path.join(dir, CONFIG_FILE))) return dir
    const up = path.dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

const read = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

const check = {
  meta: {
    type: "problem" as const,
    docs: { description: "Verify @source and @open live comments against the lockfile and AUTHORITY" },
    schema: []
  },
  create(context: RuleContext) {
    return {
      "Program:exit"() {
        const root = findRoot(context.filename)
        if (!root) return
        const configText = read(path.join(root, CONFIG_FILE))
        const config: Config = configText ? Either.getOrElse(parseConfig(configText), () => defaultConfig) : defaultConfig
        const lockText = read(path.join(root, LOCK_FILE))
        const lock = lockText ? Either.getOrElse(decodeLock(lockText), () => emptyLock) : emptyLock
        const rel = path.relative(root, context.filename).split(path.sep).join("/")
        const ev = evaluate({
          config,
          authority: parseAuthorityFile(read(path.join(root, config.authority)) ?? ""),
          authorityPath: config.authority,
          lock,
          files: [parseFile(rel, context.sourceCode.text)]
        })
        for (const d of ev.diagnostics) {
          if (d.file !== rel || d.severity === "info") continue
          context.report({ loc: { line: d.line, column: 0 }, message: `${d.code}: ${d.message}` })
        }
      }
    }
  }
}

const plugin = {
  meta: { name: "eslint-plugin-live-comments", version: "0.0.1" },
  rules: { check },
  configs: {} as Record<string, unknown>
}

plugin.configs.recommended = { plugins: { "live-comments": plugin }, rules: { "live-comments/check": "error" } }

export default plugin
