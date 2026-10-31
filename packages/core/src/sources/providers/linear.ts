import { Effect } from "effect"
import type { Account, Segment } from "../../domain.js"
import { stripMarkdown } from "../../normalize.js"
import { ExtractionFailed, NotADocument, NotFound } from "../errors.js"
import { arr, type Provider, rec, str } from "../provider.js"

// Linear issues: `linear:ENG-142`. Places are teams: `linear:team/ENG`.

const ISSUE = /^[A-Za-z][A-Za-z0-9]*-\d+$/

const ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    identifier title description url createdAt updatedAt
    creator { id name email }
    team { key }
    comments(first: 250) { nodes { id body createdAt user { id } botActor { id } } }
  }
}`

const graphql = (http: Parameters<Provider["extract"]>[1], query: string, variables: Record<string, unknown>) =>
  http({ method: "POST", path: "/graphql", body: { query, variables } })

const errorsOf = (body: unknown): ReadonlyArray<string> =>
  arr(rec(body)?.errors).map((e) => str(rec(e)?.message) ?? "error")

export const linear: Provider = {
  system: "linear",
  toolkit: "linear",
  baseUrl: "https://api.linear.app",

  classify: (body) => {
    const errs = errorsOf(body)
    if (errs.length === 0) return undefined
    const m = errs.join("; ")
    if (/not found|could not find/i.test(m)) return { kind: "not_found", message: m }
    if (/authentication|unauthori[sz]ed|forbidden/i.test(m)) return { kind: "denied", message: m }
    if (/rate ?limit/i.test(m)) return { kind: "rate_limited", message: m }
    return undefined
  },

  extract: (ref, http) =>
    Effect.gen(function* () {
      if (!ISSUE.test(ref.path)) {
        return yield* new NotADocument({ ref: ref.raw, message: "linear refs name an issue, like linear:ENG-142" })
      }
      const body = rec(yield* graphql(http, ISSUE_QUERY, { id: ref.path }))
      const issue = rec(rec(body?.data)?.issue)
      if (!issue) {
        const errs = errorsOf(body)
        return errs.length > 0
          ? yield* new ExtractionFailed({ ref: ref.raw, message: errs.join("; ") })
          : yield* new NotFound({ ref: ref.raw, message: "issue not found" })
      }
      const creatorId = str(rec(issue.creator)?.id)
      const creator: Account | undefined = creatorId ? { system: "linear", account: creatorId } : undefined
      const createdAt = str(issue.createdAt)
      const comments = arr(rec(issue.comments)?.nodes)
      const segments: Array<Segment> = [
        { text: stripMarkdown(str(issue.title) ?? ""), ...(creator ? { author: creator } : {}), ...(createdAt ? { createdAt } : {}), id: "title" },
        { text: stripMarkdown(str(issue.description) ?? ""), ...(creator ? { author: creator } : {}), ...(createdAt ? { createdAt } : {}), id: "description" },
        ...comments.map((c): Segment => {
          const r = rec(c)
          const uid = str(rec(r?.user)?.id)
          const at = str(r?.createdAt)
          return {
            text: stripMarkdown(str(r?.body) ?? ""),
            ...(uid ? { author: { system: "linear", account: uid } } : {}),
            ...(rec(r?.botActor) ? { bot: true } : {}),
            ...(at ? { createdAt: at } : {}),
            ...(str(r?.id) ? { id: `comment-${str(r?.id)}` } : {})
          }
        })
      ]
      return {
        uri: str(issue.url) ?? "",
        version: `updatedAt=${str(issue.updatedAt) ?? ""};comments=${comments.length}`,
        container: `team/${str(rec(issue.team)?.key) ?? ""}`,
        ...(creator ? { creator } : {}),
        segments
      }
    }),

  members: (place, http) =>
    Effect.gen(function* () {
      const key = place.path.replace(/^team\//, "")
      const body = rec(
        yield* graphql(http, `query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { members(first: 250) { nodes { id } } } } }`, { key })
      )
      const team = rec(arr(rec(rec(body?.data)?.teams)?.nodes)[0])
      return arr(rec(team?.members)?.nodes).flatMap((m) => {
        const id = str(rec(m)?.id)
        return id ? [{ system: "linear", account: id }] : []
      })
    }),

  directory: (_scope, http) =>
    Effect.gen(function* () {
      const body = rec(
        yield* graphql(http, `query { users(first: 250) { nodes { id name email } } teams(first: 250) { nodes { key name } } }`, {})
      )
      const data = rec(body?.data)
      return {
        accounts: arr(rec(data?.users)?.nodes).flatMap((u) => {
          const r = rec(u)
          const id = str(r?.id)
          const name = str(r?.name)
          const email = str(r?.email)
          return id ? [{ account: `linear:${id}`, ...(name ? { name } : {}), ...(email ? { email } : {}) }] : []
        }),
        places: arr(rec(data?.teams)?.nodes).flatMap((t) => {
          const r = rec(t)
          const key = str(r?.key)
          const name = str(r?.name)
          return key ? [{ place: `linear:team/${key}`, ...(name ? { name } : {}) }] : []
        })
      }
    })
}
