import { execFile } from "node:child_process"
import { readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { Data, Effect, Either } from "effect"
import { parseFile, type ParsedFile } from "../annotations/parse.js"
import { type AuthorityFile, parseAuthorityFile } from "../authority/file.js"
import { CONFIG_FILE, type Config, defaultConfig, LOCK_FILE, matchesAny, parseConfig } from "../config.js"
import { emptyLock, type Lock } from "../domain.js"
import type { Project } from "../lifecycle/evaluate.js"
import { decodeLock, encodeLock } from "../lock.js"

// Loading a project from disk. Everything after this point is pure.

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{ readonly message: string }> {}

export interface Workspace extends Project {
  readonly root: string
  readonly hasConfig: boolean
}

const SOURCE_EXT = /\.(?:[cm]?tsx?|[cm]?jsx?)$/
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", ".git", ".next", ".turbo"])

const readOptional = (file: string) =>
  Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: () => undefined }).pipe(Effect.orElseSucceed(() => undefined))

export const listSourceFiles = (root: string, ignore: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>, WorkspaceError> =>
  Effect.tryPromise({
    try: async () => {
      const out: Array<string> = []
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".") && entry.name !== ".") continue
          const abs = path.join(dir, entry.name)
          const rel = path.relative(root, abs).split(path.sep).join("/")
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name) && !matchesAny(ignore, rel)) await walk(abs)
          } else if (SOURCE_EXT.test(entry.name) && !entry.name.endsWith(".d.ts") && !matchesAny(ignore, rel)) out.push(rel)
        }
      }
      await walk(root)
      return out.sort()
    },
    catch: (e) => new WorkspaceError({ message: `cannot list files: ${String(e)}` })
  })

export const loadWorkspace = (root: string): Effect.Effect<Workspace, WorkspaceError> =>
  Effect.gen(function* () {
    const configText = yield* readOptional(path.join(root, CONFIG_FILE))
    const config: Config = configText === undefined ? defaultConfig : yield* Either.match(parseConfig(configText), {
      onLeft: (message) => Effect.fail(new WorkspaceError({ message })),
      onRight: Effect.succeed
    })
    const authorityText = (yield* readOptional(path.join(root, config.authority))) ?? ""
    const authority: AuthorityFile = parseAuthorityFile(authorityText)
    const lockText = yield* readOptional(path.join(root, LOCK_FILE))
    const lock: Lock = lockText === undefined ? emptyLock : yield* Either.match(decodeLock(lockText), {
      onLeft: (message) => Effect.fail(new WorkspaceError({ message })),
      onRight: Effect.succeed
    })
    const names = yield* listSourceFiles(root, config.ignore)
    const files: Array<ParsedFile> = []
    for (const rel of names) {
      const text = yield* readOptional(path.join(root, rel))
      if (text !== undefined) files.push(parseFile(rel, text))
    }
    return { root, hasConfig: configText !== undefined, config, authority, authorityPath: config.authority, lock, files }
  })

export const writeLock = (root: string, lock: Lock) =>
  Effect.tryPromise({
    try: () => writeFile(path.join(root, LOCK_FILE), encodeLock(lock)),
    catch: (e) => new WorkspaceError({ message: `cannot write ${LOCK_FILE}: ${String(e)}` })
  })

const git = (root: string, args: ReadonlyArray<string>) =>
  Effect.async<string, WorkspaceError>((resume) => {
    execFile("git", args as Array<string>, { cwd: root, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resume(Effect.fail(new WorkspaceError({ message: `git ${args.join(" ")}: ${stderr || err.message}` })))
      else resume(Effect.succeed(stdout))
    })
  })

/** Parse the annotated files of another revision, for `check --base`. */
export const loadRevision = (root: string, rev: string, ignore: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<ParsedFile>, WorkspaceError> =>
  Effect.gen(function* () {
    const listed = yield* git(root, ["grep", "-l", "-F", "-e", "@source", "-e", "@open", rev, "--"]).pipe(Effect.orElseSucceed(() => ""))
    const files: Array<ParsedFile> = []
    for (const line of listed.split("\n").filter(Boolean)) {
      const rel = line.slice(rev.length + 1)
      if (!SOURCE_EXT.test(rel) || rel.endsWith(".d.ts") || matchesAny(ignore, rel) || rel.split("/").some((p) => SKIP_DIRS.has(p))) continue
      const text = yield* git(root, ["show", `${rev}:${rel}`])
      files.push(parseFile(rel, text))
    }
    return files
  })
