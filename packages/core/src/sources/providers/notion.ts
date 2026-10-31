import { Effect, Either } from "effect"
import type { Account, Segment } from "../../domain.js"
import { ExtractionFailed, NotADocument, type ResolveError } from "../errors.js"
import { arr, type Http, type Provider, rec, str } from "../provider.js"
import { notionRichText } from "../richtext.js"

// Notion pages: `notion:<page id>` (32 hex characters, with or without dashes).
// Each block belongs to whoever last edited it; each comment to its author.
// Places are a page's parent: `notion:database/<id>` or `notion:page/<id>`.

const HEADERS = { "Notion-Version": "2022-06-28" }
const MAX_PAGES = 20
const MAX_DEPTH = 3
const MAX_BLOCKS = 2000

const TEXT_BLOCKS = new Set([
  "paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item",
  "to_do", "toggle", "quote", "callout", "code"
])

/** Accept a bare id, a dashed id, or anything ending in one (such as a URL slug). */
export const notionId = (path: string): string | undefined => {
  const hex = path.replace(/-/g, "").match(/([0-9a-f]{32})(?:[?#].*)?$/i)?.[1]?.toLowerCase()
  return hex ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : undefined
}

const person = (v: unknown): Account | undefined => {
  const id = str(rec(v)?.id)
  return id ? { system: "notion", account: id } : undefined
}

const paged = (http: Http, path: string, query: Record<string, string>) =>
  Effect.gen(function* () {
    const out: Array<unknown> = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = rec(yield* http({ method: "GET", path, headers: HEADERS, query: { ...query, page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) } }))
      out.push(...arr(body?.results))
      cursor = body?.has_more === true ? str(body.next_cursor) : undefined
      if (!cursor) break
    }
    return out
  })

const blockText = (b: Record<string, unknown>): string => {
  const type = str(b.type) ?? ""
  const data = rec(b[type])
  if (TEXT_BLOCKS.has(type)) return notionRichText(data?.rich_text)
  if (type === "table_row") return arr(data?.cells).map(notionRichText).join("\n")
  if (type === "child_page" || type === "child_database") return str(data?.title) ?? ""
  return ""
}

export const notion: Provider = {
  system: "notion",
  toolkit: "notion",
  baseUrl: "https://api.notion.com",

  classify: (body) => {
    const b = rec(body)
    if (str(b?.object) !== "error") return undefined
    const code = str(b?.code) ?? ""
    const message = str(b?.message) ?? code
    if (code === "object_not_found") return { kind: "not_found", message }
    if (code === "unauthorized" || code === "restricted_resource") return { kind: "denied", message }
    if (code === "rate_limited") return { kind: "rate_limited", message }
    return undefined
  },

  extract: (ref, http) =>
    Effect.gen(function* () {
      const id = notionId(ref.path)
      if (!id) return yield* new NotADocument({ ref: ref.raw, message: "notion refs name a page, like notion:8f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f" })
      const page = rec(yield* http({ method: "GET", path: `/v1/pages/${id}`, headers: HEADERS }))
      if (!page || str(page.object) !== "page") return yield* new ExtractionFailed({ ref: ref.raw, message: "unexpected response for page" })

      const titleProp = Object.values(rec(page.properties) ?? {}).map(rec).find((p) => str(p?.type) === "title")
      const creator = person(page.created_by)
      const segments: Array<Segment> = [{ text: notionRichText(titleProp?.title), ...(creator ? { author: creator } : {}), id: "title" }]

      // Blocks, depth-first, so the text reads in page order.
      let count = 0
      const walk = (blockId: string, depth: number): Effect.Effect<void, ResolveError> =>
        Effect.gen(function* () {
          const children = yield* paged(http, `/v1/blocks/${blockId}/children`, {})
          for (const raw of children) {
            if (++count > MAX_BLOCKS) return
            const b = rec(raw)
            if (!b) continue
            const author = person(b.last_edited_by) ?? person(b.created_by)
            const at = str(b.last_edited_time) ?? str(b.created_time)
            segments.push({ text: blockText(b), ...(author ? { author } : {}), ...(at ? { createdAt: at } : {}), ...(str(b.id) ? { id: `block-${str(b.id)}` } : {}) })
            const type = str(b.type)
            if (b.has_children === true && depth < MAX_DEPTH && type !== "child_page" && type !== "child_database") yield* walk(str(b.id)!, depth + 1)
          }
        })
      yield* walk(id, 0)

      // Comments need the integration's comment capability; without it the page still resolves.
      const comments = yield* Effect.either(paged(http, "/v1/comments", { block_id: id }))
      if (Either.isRight(comments)) {
        for (const raw of comments.right) {
          const c = rec(raw)
          const author = person(c?.created_by)
          const at = str(c?.created_time)
          segments.push({ text: notionRichText(c?.rich_text), ...(author ? { author } : {}), ...(at ? { createdAt: at } : {}), ...(str(c?.id) ? { id: `comment-${str(c?.id)}` } : {}) })
        }
      }

      const parent = rec(page.parent)
      const container =
        str(parent?.type) === "database_id" ? `database/${str(parent?.database_id)}` : str(parent?.type) === "page_id" ? `page/${str(parent?.page_id)}` : "workspace"
      return {
        uri: str(page.url) ?? `https://www.notion.so/${id.replace(/-/g, "")}`,
        version: `last_edited_time=${str(page.last_edited_time) ?? ""};comments=${Either.isRight(comments) ? comments.right.length : "?"}`,
        container,
        ...(creator ? { creator } : {}),
        segments
      }
    }),

  directory: (_scope, http) =>
    Effect.gen(function* () {
      const users = yield* paged(http, "/v1/users", {})
      return {
        accounts: users.flatMap((u) => {
          const r = rec(u)
          const id = str(r?.id)
          if (!id || str(r?.type) === "bot") return []
          const name = str(r?.name)
          const email = str(rec(r?.person)?.email)
          return [{ account: `notion:${id}`, ...(name ? { name } : {}), ...(email ? { email } : {}) }]
        }),
        places: []
      }
    })
}
