import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import type { Segment } from "../domain.js"
import { stripMarkdown } from "../normalize.js"
import { NotFound } from "./errors.js"
import type { Extracted } from "./provider.js"

// The built-in `file` binding: files in the repository, attributed line by
// line to their commit author as `git blame` reports it (accounts `email:…`).

const blame = (root: string, rel: string): Promise<ReadonlyArray<string | undefined>> =>
  new Promise((resolve) => {
    execFile("git", ["blame", "--line-porcelain", "--", rel], { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([])
      const authors: Array<string | undefined> = []
      let mail: string | undefined
      let uncommitted = false
      for (const line of stdout.split("\n")) {
        if (/^[0-9a-f]{40} /.test(line)) {
          uncommitted = line.startsWith("0000000000000000000000000000000000000000")
          mail = undefined
        } else if (line.startsWith("author-mail ")) mail = line.slice(12).replace(/^<|>$/g, "")
        else if (line.startsWith("\t")) authors.push(uncommitted ? undefined : mail)
      }
      resolve(authors)
    })
  })

export const extractFile = (root: string, rel: string, ref: string): Effect.Effect<Extracted, NotFound> =>
  Effect.tryPromise({
    try: async () => {
      const abs = path.resolve(root, rel)
      if (!abs.startsWith(path.resolve(root) + path.sep)) throw new Error("outside the repository")
      const text = await readFile(abs, "utf8")
      const authors = await blame(root, rel)
      const markdown = /\.mdx?$/i.test(rel)
      const segments: Array<Segment> = text.split(/\r?\n/).map((line, i) => {
        const mail = authors[i]
        return {
          text: markdown ? stripMarkdown(line) : line,
          ...(mail ? { author: { system: "email", account: mail } } : {})
        }
      })
      const dir = path.posix.dirname(rel.split(path.sep).join("/"))
      return { uri: `file:${rel}`, container: dir === "." ? "" : dir, segments }
    },
    catch: (e) => new NotFound({ ref, message: `cannot read ${rel}: ${e instanceof Error ? e.message : String(e)}` })
  })
