import { Effect } from "effect"
import type { Account, Segment } from "../../domain.js"
import { ExtractionFailed, NotADocument } from "../errors.js"
import { arr, type Provider, rec, str } from "../provider.js"
import { adfToText } from "../richtext.js"

// Jira Cloud issues: `jira:PAY-311`. The summary and description belong to the
// issue's creator; each comment to its author. Places are projects:
// `jira:project/PAY`. The API host differs per site, so the resolver sets
// `baseUrl`.

const ISSUE = /^[A-Z][A-Z0-9_]*-\d+$/
const MAX_PAGES = 20

const user = (v: unknown): { author?: Account; bot: boolean } => {
  const r = rec(v)
  const id = str(r?.accountId)
  return { ...(id ? { author: { system: "jira", account: id } } : {}), bot: str(r?.accountType) === "app" }
}

export const jira: Provider = {
  system: "jira",
  toolkit: "jira",
  baseUrl: "",
  baseUrlHint:
    'set "baseUrl" on the jira resolver: "https://<site>.atlassian.net" with Composio, or "https://api.atlassian.com/ex/jira/<cloudId>" with Nango',

  classify: (body) => {
    const msgs = arr(rec(body)?.errorMessages).map((m) => String(m))
    if (msgs.length === 0) return undefined
    const m = msgs.join("; ")
    if (/does not exist|not found/i.test(m)) return { kind: "not_found", message: m }
    if (/permission|not authorized|unauthori[sz]ed|log in/i.test(m)) return { kind: "denied", message: m }
    return undefined
  },

  extract: (ref, http) =>
    Effect.gen(function* () {
      if (!ISSUE.test(ref.path)) return yield* new NotADocument({ ref: ref.raw, message: "jira refs name an issue, like jira:PAY-311" })
      const issue = rec(
        yield* http({
          method: "GET",
          path: `/rest/api/3/issue/${ref.path}`,
          query: { fields: "summary,description,creator,reporter,project,created,updated" }
        })
      )
      const fields = rec(issue?.fields)
      if (!issue || !fields) return yield* new ExtractionFailed({ ref: ref.raw, message: "unexpected response for issue" })

      const comments: Array<unknown> = []
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = rec(
          yield* http({ method: "GET", path: `/rest/api/3/issue/${ref.path}/comment`, query: { startAt: String(page * 100), maxResults: "100" } })
        )
        const batch = arr(body?.comments)
        comments.push(...batch)
        if (batch.length < 100) break
      }

      const creator = user(fields.creator ?? fields.reporter)
      const createdAt = str(fields.created)
      const segments: Array<Segment> = [
        { text: str(fields.summary) ?? "", ...creator, ...(createdAt ? { createdAt } : {}), id: "summary" },
        { text: adfToText(fields.description), ...creator, ...(createdAt ? { createdAt } : {}), id: "description" },
        ...comments.map((raw): Segment => {
          const c = rec(raw)
          const at = str(c?.created)
          return { text: adfToText(c?.body), ...user(c?.author), ...(at ? { createdAt: at } : {}), ...(str(c?.id) ? { id: `comment-${str(c?.id)}` } : {}) }
        })
      ]
      const self = str(issue.self) ?? ""
      const site = self.replace(/\/rest\/api\/.*$/, "")
      const lastComment = comments.length > 0 ? str(rec(comments[comments.length - 1])?.updated) : undefined
      return {
        uri: site ? `${site}/browse/${ref.path}` : ref.raw,
        version: `updated=${str(fields.updated) ?? ""};comments=${comments.length};last=${lastComment ?? ""}`,
        container: `project/${str(rec(fields.project)?.key) ?? ref.path.split("-")[0]}`,
        ...(creator.author ? { creator: creator.author } : {}),
        creatorIsBot: creator.bot,
        segments
      }
    }),

  directory: (_scope, http) =>
    Effect.gen(function* () {
      const users = arr(yield* http({ method: "GET", path: "/rest/api/3/users/search", query: { maxResults: "1000" } }))
      const projects = arr(rec(yield* http({ method: "GET", path: "/rest/api/3/project/search", query: { maxResults: "100" } }))?.values)
      return {
        accounts: users.flatMap((u) => {
          const r = rec(u)
          const id = str(r?.accountId)
          if (!id || str(r?.accountType) !== "atlassian") return []
          const name = str(r?.displayName)
          const email = str(r?.emailAddress)
          return [{ account: `jira:${id}`, ...(name ? { name } : {}), ...(email ? { email } : {}) }]
        }),
        places: projects.flatMap((p) => {
          const r = rec(p)
          const key = str(r?.key)
          const name = str(r?.name)
          return key ? [{ place: `jira:project/${key}`, ...(name ? { name } : {}) }] : []
        })
      }
    })
}
