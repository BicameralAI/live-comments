import { Effect } from "effect"
import { parseFile } from "../src/annotations/parse.js"
import { parseAuthorityFile } from "../src/authority/file.js"
import { type Config, defaultConfig } from "../src/config.js"
import { emptyLock, type Lock } from "../src/domain.js"
import type { HttpRequest, HttpResponse } from "../src/sources/transport.js"
import { makeSources, Sources } from "../src/sources/resolve.js"
import type { Workspace } from "../src/workflows/workspace.js"

export const config = (over: Partial<Config> = {}): Config => ({
  ...defaultConfig,
  resolvers: { file: { builtin: "file" }, github: { provider: "github" }, linear: { provider: "linear" } },
  ...over
})

/** An in-memory workspace: files are path → code. */
export const workspace = (opts: {
  files?: Record<string, string>
  authority?: string
  lock?: Lock
  config?: Partial<Config>
  root?: string
}): Workspace => ({
  root: opts.root ?? "/nonexistent",
  hasConfig: true,
  config: config(opts.config),
  authority: parseAuthorityFile(opts.authority ?? ""),
  authorityPath: "AUTHORITY",
  lock: opts.lock ?? emptyLock,
  files: Object.entries(opts.files ?? {}).map(([f, code]) => parseFile(f, code))
})

/** Run an Effect needing Sources against a fixture HTTP handler (full URL → response). */
export const withFixture = <A, E>(
  ws: Workspace,
  handler: (url: string, req: HttpRequest) => HttpResponse | undefined,
  eff: Effect.Effect<A, E, Sources>
): Promise<A> => {
  const transports = {
    get: () => ({
      name: "fixture",
      request: (req: HttpRequest) => {
        const qs = req.query && Object.keys(req.query).length > 0 ? "?" + new URLSearchParams(req.query).toString() : ""
        const url = req.baseUrl + req.path + qs
        return Effect.succeed(handler(url, req) ?? { status: 404, body: { message: "Not Found" } })
      }
    })
  }
  const sources = makeSources(ws.config, ws.root, transports, () => new Date("2026-10-30T00:00:00Z"))
  return Effect.runPromise(Effect.provideService(eff, Sources, sources))
}

export interface FakeComment {
  readonly id: number
  readonly login: string
  readonly bot?: boolean
  readonly body: string
  readonly created_at?: string
}

export interface FakeIssue {
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly login: string
  readonly title: string
  readonly body: string
  readonly comments: ReadonlyArray<FakeComment>
  readonly updated_at?: string
}

/** Answers GitHub API requests for a set of issues and org memberships. */
export const githubFixture = (issues: ReadonlyArray<FakeIssue>, orgs: Record<string, ReadonlyArray<string>> = {}) => (url: string): HttpResponse | undefined => {
  for (const i of issues) {
    const base = `https://api.github.com/repos/${i.owner}/${i.repo}/issues/${i.number}`
    if (url === base) {
      return {
        status: 200,
        body: {
          number: i.number,
          title: i.title,
          body: i.body,
          user: { login: i.login, type: "User" },
          created_at: "2026-10-01T00:00:00Z",
          updated_at: i.updated_at ?? "2026-10-02T00:00:00Z",
          html_url: `https://github.com/${i.owner}/${i.repo}/issues/${i.number}`
        }
      }
    }
    if (url.startsWith(base + "/comments")) {
      const page = Number(new URL(url).searchParams.get("page") ?? "1")
      return {
        status: 200,
        body:
          page === 1
            ? i.comments.map((c) => ({
                id: c.id,
                body: c.body,
                user: { login: c.login, type: c.bot ? "Bot" : "User" },
                created_at: c.created_at ?? "2026-10-03T00:00:00Z",
                updated_at: c.created_at ?? "2026-10-03T00:00:00Z"
              }))
            : []
      }
    }
  }
  for (const [org, logins] of Object.entries(orgs)) {
    if (url.startsWith(`https://api.github.com/orgs/${org}/members`)) {
      const page = Number(new URL(url).searchParams.get("page") ?? "1")
      return { status: 200, body: page === 1 ? logins.map((login) => ({ login })) : [] }
    }
  }
  return undefined
}

export const codes = (ds: ReadonlyArray<{ code: string }>) => ds.map((d) => d.code)
