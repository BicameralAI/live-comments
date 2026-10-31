import { Effect, Either } from "effect"
import type { Account, Segment } from "../../domain.js"
import { ExtractionFailed, NotADocument } from "../errors.js"
import { arr, type Provider, rec, str } from "../provider.js"
import { gdocsToText } from "../richtext.js"

// Google Docs: `gdocs:<document id>`. The Docs API has no per-paragraph authors,
// so the body belongs to the document's owner, read from the Drive API. Comments
// and replies, where decisions are often made, belong to their authors.
// Accounts are email addresses (`email:…`), matching git and AUTHORITY person lines.
// Places are Drive folders: `gdocs:folder/<id>`.

const DOC = /^[A-Za-z0-9_-]{20,}$/
const DRIVE = { baseUrl: "https://www.googleapis.com", toolkit: "googledrive" } as const

const email = (v: unknown): Account | undefined => {
  const e = str(rec(v)?.emailAddress)
  return e ? { system: "email", account: e.toLowerCase() } : undefined
}

/** All tab bodies, in order; documents without tabs use `body`. */
const tabContents = (doc: Record<string, unknown>): ReadonlyArray<unknown> => {
  const tabs = arr(doc.tabs)
  if (tabs.length === 0) return [rec(doc.body)?.content]
  const out: Array<unknown> = []
  const visit = (t: unknown) => {
    const r = rec(t)
    out.push(rec(rec(r?.documentTab)?.body)?.content)
    for (const child of arr(r?.childTabs)) visit(child)
  }
  for (const t of tabs) visit(t)
  return out
}

export const gdocs: Provider = {
  system: "gdocs",
  toolkit: "googledocs",
  baseUrl: "https://docs.googleapis.com",

  classify: (body) => {
    const err = rec(rec(body)?.error)
    if (!err) return undefined
    const status = str(err.status) ?? ""
    const message = str(err.message) ?? status
    if (status === "NOT_FOUND" || err.code === 404) return { kind: "not_found", message }
    if (status === "PERMISSION_DENIED" || status === "UNAUTHENTICATED" || err.code === 401 || err.code === 403) return { kind: "denied", message }
    if (status === "RESOURCE_EXHAUSTED" || err.code === 429) return { kind: "rate_limited", message }
    return undefined
  },

  extract: (ref, http) =>
    Effect.gen(function* () {
      if (!DOC.test(ref.path)) return yield* new NotADocument({ ref: ref.raw, message: "gdocs refs name a document, like gdocs:1AbC…" })
      const doc = rec(yield* http({ method: "GET", path: `/v1/documents/${ref.path}`, query: { includeTabsContent: "true" } }))
      if (!doc || !str(doc.documentId)) return yield* new ExtractionFailed({ ref: ref.raw, message: "unexpected response for document" })

      // Owner and comments come from Drive. A document stays readable without them.
      const file = yield* Effect.either(
        http({
          method: "GET",
          ...DRIVE,
          path: `/drive/v3/files/${ref.path}`,
          query: { fields: "owners(emailAddress,displayName),parents,webViewLink,modifiedTime", supportsAllDrives: "true" }
        })
      )
      const comments = yield* Effect.either(
        http({
          method: "GET",
          ...DRIVE,
          path: `/drive/v3/files/${ref.path}/comments`,
          query: {
            fields: "comments(id,content,createdTime,deleted,author(emailAddress,displayName),replies(id,content,createdTime,deleted,author(emailAddress,displayName)))",
            pageSize: "100"
          }
        })
      )
      const meta = Either.isRight(file) ? rec(file.right) : undefined
      const owner = email(arr(meta?.owners)[0])

      const segments: Array<Segment> = [
        { text: str(doc.title) ?? "", ...(owner ? { author: owner } : {}), id: "title" },
        ...tabContents(doc).map((content, i): Segment => ({ text: gdocsToText(content), ...(owner ? { author: owner } : {}), id: `tab-${i}` }))
      ]
      const threads = Either.isRight(comments) ? arr(rec(comments.right)?.comments) : []
      for (const raw of threads) {
        const c = rec(raw)
        if (!c || c.deleted === true) continue
        for (const m of [c, ...arr(c.replies).map(rec)]) {
          if (!m || m.deleted === true) continue
          const author = email(m.author)
          const at = str(m.createdTime)
          segments.push({ text: str(m.content) ?? "", ...(author ? { author } : {}), ...(at ? { createdAt: at } : {}), ...(str(m.id) ? { id: `comment-${str(m.id)}` } : {}) })
        }
      }

      const parent = str(arr(meta?.parents)[0])
      return {
        uri: str(meta?.webViewLink) ?? `https://docs.google.com/document/d/${ref.path}/edit`,
        version: `revision=${str(doc.revisionId) ?? ""};comments=${Either.isRight(comments) ? threads.length : "?"}`,
        container: parent ? `folder/${parent}` : "",
        ...(owner ? { creator: owner } : {}),
        segments
      }
    })
}
