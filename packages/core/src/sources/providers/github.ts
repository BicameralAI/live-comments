import { Effect } from "effect"
import type { Account, Segment } from "../../domain.js"
import { stripMarkdown } from "../../normalize.js"
import { ExtractionFailed, NotADocument } from "../errors.js"
import { arr, type Provider, rec, str } from "../provider.js"

// GitHub issues and pull requests: `github:owner/repo#123`.
// The title and body belong to the issue's author; each comment to its own.

const ISSUE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/
const MAX_PAGES = 20

const user = (u: unknown): { author?: Account; bot: boolean } => {
  const r = rec(u)
  const login = str(r?.login)
  return { ...(login ? { author: { system: "github", account: login } } : {}), bot: str(r?.type) === "Bot" }
}

export const github: Provider = {
  system: "github",
  toolkit: "github",
  baseUrl: "https://api.github.com",

  classify: (body) => {
    const m = str(rec(body)?.message)
    if (!m) return undefined
    if (m === "Not Found") return { kind: "not_found", message: m }
    if (/Bad credentials|Requires authentication|Resource not accessible|Must have admin rights/i.test(m)) return { kind: "denied", message: m }
    if (/rate limit/i.test(m)) return { kind: "rate_limited", message: m }
    return undefined
  },

  extract: (ref, http) =>
    Effect.gen(function* () {
      const m = ISSUE.exec(ref.path)
      if (!m) {
        return yield* new NotADocument({ ref: ref.raw, message: "github refs name an issue or pull request, like github:owner/repo#123" })
      }
      const [, owner, repo, number] = m
      const issue = rec(yield* http({ method: "GET", path: `/repos/${owner}/${repo}/issues/${number}` }))
      if (!issue || typeof issue.number !== "number") {
        return yield* new ExtractionFailed({ ref: ref.raw, message: "unexpected response for issue" })
      }
      const comments: Array<unknown> = []
      for (let page = 1; page <= MAX_PAGES; page++) {
        const batch = arr(
          yield* http({
            method: "GET",
            path: `/repos/${owner}/${repo}/issues/${number}/comments`,
            query: { per_page: "100", page: String(page) }
          })
        )
        comments.push(...batch)
        if (batch.length < 100) break
      }
      const author = user(issue.user)
      const createdAt = str(issue.created_at)
      const segments: Array<Segment> = [
        { text: str(issue.title) ?? "", ...author, ...(createdAt ? { createdAt } : {}), id: "title" },
        { text: stripMarkdown(str(issue.body) ?? ""), ...author, ...(createdAt ? { createdAt } : {}), id: "body" },
        ...comments.map((c): Segment => {
          const r = rec(c)
          const at = str(r?.created_at)
          return {
            text: stripMarkdown(str(r?.body) ?? ""),
            ...user(r?.user),
            ...(at ? { createdAt: at } : {}),
            ...(r?.id !== undefined ? { id: `comment-${String(r.id)}` } : {})
          }
        })
      ]
      const lastComment = comments.length > 0 ? str(rec(comments[comments.length - 1])?.updated_at) : undefined
      return {
        uri: str(issue.html_url) ?? `https://github.com/${owner}/${repo}/issues/${number}`,
        version: `updated_at=${str(issue.updated_at) ?? ""};comments=${comments.length};last=${lastComment ?? ""}`,
        container: `${owner}/${repo}`,
        ...(author.author ? { creator: author.author } : {}),
        creatorIsBot: author.bot,
        segments
      }
    }),

  members: (place, http) =>
    Effect.gen(function* () {
      const [owner, repo] = place.path.split("/")
      const path = repo ? `/repos/${owner}/${repo}/collaborators` : `/orgs/${owner}/members`
      const out: Array<Account> = []
      for (let page = 1; page <= MAX_PAGES; page++) {
        const batch = arr(yield* http({ method: "GET", path, query: { per_page: "100", page: String(page) } }))
        for (const u of batch) {
          const login = str(rec(u)?.login)
          if (login) out.push({ system: "github", account: login })
        }
        if (batch.length < 100) break
      }
      return out
    }),

  directory: (scope, http) =>
    Effect.gen(function* () {
      if (!scope) return { accounts: [], places: [] }
      const members = arr(yield* http({ method: "GET", path: `/orgs/${scope}/members`, query: { per_page: "100" } }))
      const repos = arr(yield* http({ method: "GET", path: `/orgs/${scope}/repos`, query: { per_page: "100" } }))
      return {
        accounts: members.flatMap((u) => {
          const login = str(rec(u)?.login)
          return login ? [{ account: `github:${login}` }] : []
        }),
        places: [
          { place: `github:${scope}`, name: scope },
          ...repos.flatMap((r) => {
            const full = str(rec(r)?.full_name)
            return full ? [{ place: `github:${full}`, name: full }] : []
          })
        ]
      }
    })
}
