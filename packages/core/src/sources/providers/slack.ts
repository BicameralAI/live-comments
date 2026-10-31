import { Effect } from "effect"
import type { Account, Segment } from "../../domain.js"
import { ExtractionFailed, NotADocument } from "../errors.js"
import { arr, type Http, type Provider, rec, str } from "../provider.js"
import { slackToText } from "../richtext.js"

// Slack threads: `slack:C0123ABCD/1793415412.122609` (channel id / message ts).
// Each message belongs to its author. Places are channels: `slack:channel/C0123ABCD`.

const THREAD = /^([CGD][A-Z0-9]+)\/(\d+\.\d+)$/
const MAX_PAGES = 20

const NOT_FOUND = new Set(["channel_not_found", "thread_not_found", "message_not_found"])
const DENIED = new Set(["not_in_channel", "missing_scope", "invalid_auth", "not_authed", "account_inactive", "token_revoked", "access_denied", "no_permission"])

/** Follow `response_metadata.next_cursor` and collect one array field from each page. */
const paged = (http: Http, path: string, query: Record<string, string>, field: string) =>
  Effect.gen(function* () {
    const out: Array<unknown> = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = rec(yield* http({ method: "GET", path, query: { ...query, ...(cursor ? { cursor } : {}) } }))
      out.push(...arr(body?.[field]))
      cursor = str(rec(body?.response_metadata)?.next_cursor) || undefined
      if (!cursor) break
    }
    return out
  })

export const slack: Provider = {
  system: "slack",
  toolkit: "slack",
  baseUrl: "https://slack.com/api",

  classify: (body) => {
    const b = rec(body)
    if (!b || b.ok !== false) return undefined
    const e = str(b.error) ?? "error"
    if (NOT_FOUND.has(e)) return { kind: "not_found", message: e }
    if (DENIED.has(e)) return { kind: "denied", message: e }
    if (e === "ratelimited") return { kind: "rate_limited", message: e }
    return undefined
  },

  extract: (ref, http) =>
    Effect.gen(function* () {
      const m = THREAD.exec(ref.path)
      if (!m) return yield* new NotADocument({ ref: ref.raw, message: "slack refs name a message or thread, like slack:C0123ABCD/1793415412.122609" })
      const [, channel, ts] = m
      const messages = yield* paged(http, "/conversations.replies", { channel: channel!, ts: ts!, limit: "200" }, "messages")
      if (messages.length === 0) return yield* new ExtractionFailed({ ref: ref.raw, message: "no messages returned" })
      let edited = ""
      const segments = messages.map((raw): Segment => {
        const msg = rec(raw)
        const user = str(msg?.user)
        const e = str(rec(msg?.edited)?.ts)
        if (e && e > edited) edited = e
        return {
          text: slackToText(str(msg?.text) ?? ""),
          ...(user ? { author: { system: "slack", account: user } } : {}),
          ...(msg?.bot_id !== undefined || str(msg?.subtype) === "bot_message" ? { bot: true } : {}),
          ...(str(msg?.ts) ? { createdAt: new Date(Number(str(msg?.ts)) * 1000).toISOString(), id: `ts-${str(msg?.ts)}` } : {})
        }
      })
      const first = rec(messages[0])
      const creator = str(first?.user)
      const last = str(rec(messages[messages.length - 1])?.ts) ?? ""
      return {
        uri: `https://slack.com/archives/${channel}/p${ts!.replace(".", "")}`,
        version: `latest=${last};count=${messages.length};edited=${edited}`,
        container: `channel/${channel}`,
        ...(creator ? { creator: { system: "slack", account: creator } } : {}),
        ...(first?.bot_id !== undefined ? { creatorIsBot: true } : {}),
        segments
      }
    }),

  members: (place, http) =>
    Effect.gen(function* () {
      const channel = place.path.replace(/^channel\//, "")
      const ids = yield* paged(http, "/conversations.members", { channel, limit: "200" }, "members")
      return ids.flatMap((id): ReadonlyArray<Account> => (typeof id === "string" ? [{ system: "slack", account: id }] : []))
    }),

  directory: (_scope, http) =>
    Effect.gen(function* () {
      const users = yield* paged(http, "/users.list", { limit: "200" }, "members")
      const channels = yield* paged(http, "/conversations.list", { limit: "200", types: "public_channel,private_channel", exclude_archived: "true" }, "channels")
      return {
        accounts: users.flatMap((u) => {
          const r = rec(u)
          const id = str(r?.id)
          if (!id || r?.deleted === true || r?.is_bot === true) return []
          const name = str(r?.real_name) ?? str(r?.name)
          const email = str(rec(r?.profile)?.email)
          return [{ account: `slack:${id}`, ...(name ? { name } : {}), ...(email ? { email } : {}) }]
        }),
        places: channels.flatMap((c) => {
          const r = rec(c)
          const id = str(r?.id)
          const name = str(r?.name)
          return id ? [{ place: `slack:channel/${id}`, ...(name ? { name: `#${name}` } : {}) }] : []
        })
      }
    })
}
