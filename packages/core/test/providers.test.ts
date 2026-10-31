import { Effect, Either } from "effect"
import { describe, expect, it } from "vitest"
import type { Snapshot } from "../src/domain.js"
import { notionId } from "../src/sources/providers/notion.js"
import { adfToText, gdocsToText, slackToText } from "../src/sources/richtext.js"
import { Sources } from "../src/sources/resolve.js"
import type { HttpRequest, HttpResponse } from "../src/sources/transport.js"
import { withFixture, workspace } from "./helpers.js"

const ws = workspace({
  config: {
    resolvers: {
      notion: { provider: "notion" },
      jira: { provider: "jira", baseUrl: "https://acme.atlassian.net" },
      jirabare: { provider: "jira" },
      gdocs: { provider: "gdocs" },
      slack: { provider: "slack" }
    }
  }
})

const resolve = (ref: string, handler: (url: string, req: HttpRequest) => HttpResponse | undefined) =>
  withFixture(ws, handler, Effect.either(Effect.flatMap(Sources, (s) => s.resolve(ref))))

const ok = (body: unknown): HttpResponse => ({ status: 200, body })

/** The author of the span holding `words`. */
const authorOf = (s: Snapshot, words: string) => {
  const at = s.text.indexOf(words)
  return s.attribution.find((a) => a.start <= at && a.end > at)?.author?.account
}

describe("rich text", () => {
  it("flattens Atlassian documents", () => {
    const adf = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Refunds within " }, { type: "text", text: "14 days", marks: [{ type: "strong" }] }, { type: "text", text: "." }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { text: "@Pat" } }, { type: "text", text: " approves" }] }] }] }
      ]
    }
    expect(adfToText(adf).replace(/\s+/g, " ").trim()).toBe("Refunds within 14 days. @Pat approves")
  })

  it("flattens Slack formatting", () => {
    expect(slackToText("*Decision:* codes don't stack, see <https://x.example/p|the policy> cc <@U123> &amp; <#C9|pricing>")).toBe(
      "Decision: codes don't stack, see the policy cc @U123 & #pricing"
    )
  })

  it("flattens Google Docs structure, including tables", () => {
    const content = [
      { paragraph: { elements: [{ textRun: { content: "Policy\n" } }] } },
      { table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: "Tier" } }] } }] }, { content: [{ paragraph: { elements: [{ textRun: { content: "Gold" } }] } }] }] }] } }
    ]
    expect(gdocsToText(content).replace(/\s+/g, " ").trim()).toBe("Policy Tier Gold")
  })

  it("accepts Notion ids in any common form", () => {
    const id = "8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f"
    expect(notionId("8f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f")).toBe(id)
    expect(notionId("Pricing-Policy-8f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f")).toBe(id)
    expect(notionId("nope")).toBeUndefined()
  })
})

describe("slack", () => {
  const handler = (url: string) => {
    if (url.startsWith("https://slack.com/api/conversations.replies?channel=C0PRICE&ts=1793415412.122609")) {
      return ok({
        ok: true,
        messages: [
          { user: "U0PAT", text: "Do gift cards stack with discounts?", ts: "1793415412.122609" },
          { user: "U0EVE", text: "I think *yes*", ts: "1793415500.000100" },
          { bot_id: "B1", user: "U0BOT", text: "Reminder: decide by Friday", ts: "1793415600.000100" },
          { user: "U0PAT", text: "No: gift cards apply *after* discounts.", ts: "1793415700.000100", edited: { ts: "1793415800.000000" } }
        ],
        has_more: false
      })
    }
    if (url.includes("conversations.replies?channel=C0GONE")) return ok({ ok: false, error: "channel_not_found" })
    if (url.includes("conversations.replies?channel=C0PRIV")) return ok({ ok: false, error: "not_in_channel" })
    return undefined
  }

  it("attributes each message to its author and flags bots", async () => {
    const r = await resolve("slack:C0PRICE/1793415412.122609", handler)
    const s = Either.getOrThrow(r)
    expect(s.text).toContain("No: gift cards apply after discounts.")
    expect(authorOf(s, "No: gift cards")).toBe("U0PAT")
    expect(authorOf(s, "I think yes")).toBe("U0EVE")
    expect(s.attribution.find((a) => s.text.slice(a.start, a.end).startsWith("Reminder"))?.bot).toBe(true)
    expect(s.container).toBe("channel/C0PRICE")
    expect(s.uri).toBe("https://slack.com/archives/C0PRICE/p1793415412122609")
    expect(s.version).toContain("edited=1793415800.000000")
  })

  it("maps Slack errors", async () => {
    expect(Either.flip(await resolve("slack:C0GONE/1.2", handler)).pipe(Either.getOrThrow)._tag).toBe("NotFound")
    expect(Either.flip(await resolve("slack:C0PRIV/1.2", handler)).pipe(Either.getOrThrow)._tag).toBe("Denied")
    expect(Either.flip(await resolve("slack:channel/C0PRICE", handler)).pipe(Either.getOrThrow)._tag).toBe("NotADocument")
  })

  it("lists channel members", async () => {
    const r = await withFixture(
      ws,
      (url) => (url.includes("conversations.members?channel=C0PRICE") ? ok({ ok: true, members: ["U0PAT", "U0EVE"] }) : undefined),
      Effect.flatMap(Sources, (s) => s.members({ system: "slack", path: "channel/C0PRICE" }))
    )
    expect(r.map((a) => a.account)).toEqual(["U0PAT", "U0EVE"])
  })
})

describe("notion", () => {
  const page = "8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f"
  const handler = (url: string, req: HttpRequest) => {
    expect(req.headers?.["Notion-Version"]).toBe("2022-06-28")
    if (url === `https://api.notion.com/v1/pages/${page}`) {
      return ok({
        object: "page",
        id: page,
        url: "https://www.notion.so/Pricing-8f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f",
        created_by: { object: "user", id: "u-pat" },
        last_edited_time: "2026-10-20T00:00:00.000Z",
        parent: { type: "database_id", database_id: "db-decisions" },
        properties: { Name: { type: "title", title: [{ plain_text: "Pricing decisions" }] } }
      })
    }
    if (url.startsWith(`https://api.notion.com/v1/blocks/${page}/children`)) {
      return ok({
        object: "list",
        results: [
          { id: "b1", type: "heading_2", heading_2: { rich_text: [{ plain_text: "Discounts" }] }, last_edited_by: { id: "u-pat" }, has_children: false },
          { id: "b2", type: "toggle", toggle: { rich_text: [{ plain_text: "Details" }] }, last_edited_by: { id: "u-pat" }, has_children: true },
          { id: "b3", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Codes " }, { plain_text: "do not stack." }] }, last_edited_by: { id: "u-eve" }, has_children: false }
        ],
        has_more: false
      })
    }
    if (url.startsWith("https://api.notion.com/v1/blocks/b2/children")) {
      return ok({ results: [{ id: "b2a", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Best single discount wins." }] }, last_edited_by: { id: "u-pat" } }], has_more: false })
    }
    if (url.startsWith("https://api.notion.com/v1/comments")) {
      return ok({ results: [{ id: "c1", rich_text: [{ plain_text: "Approved for launch." }], created_by: { id: "u-pat" }, created_time: "2026-10-21T00:00:00.000Z" }], has_more: false })
    }
    return { status: 404, body: { object: "error", code: "object_not_found", message: "Could not find page" } }
  }

  it("reads blocks in page order, nested ones included, with their last editors", async () => {
    const s = Either.getOrThrow(await resolve(`notion:${page}`, handler))
    expect(s.text).toBe("Pricing decisions Discounts Details Best single discount wins. Codes do not stack. Approved for launch.")
    expect(authorOf(s, "Codes do not stack.")).toBe("u-eve")
    expect(authorOf(s, "Approved for launch.")).toBe("u-pat")
    expect(s.container).toBe("database/db-decisions")
  })

  it("still resolves when the integration cannot read comments", async () => {
    const noComments = (url: string, req: HttpRequest) =>
      url.startsWith("https://api.notion.com/v1/comments") ? { status: 403, body: { object: "error", code: "restricted_resource", message: "no" } } : handler(url, req)
    const s = Either.getOrThrow(await resolve(`notion:${page}`, noComments))
    expect(s.text).not.toContain("Approved")
    expect(s.version).toContain("comments=?")
  })

  it("maps a missing page to NotFound", async () => {
    expect(Either.flip(await resolve("notion:00000000000000000000000000000000", handler)).pipe(Either.getOrThrow)._tag).toBe("NotFound")
  })
})

describe("jira", () => {
  const handler = (url: string) => {
    if (url === "https://acme.atlassian.net/rest/api/3/issue/PAY-311?fields=summary%2Cdescription%2Ccreator%2Creporter%2Cproject%2Ccreated%2Cupdated") {
      return ok({
        key: "PAY-311",
        self: "https://acme.atlassian.net/rest/api/3/issue/10001",
        fields: {
          summary: "Refund window",
          description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Refunds are allowed within 14 days." }] }] },
          creator: { accountId: "acc-pat", accountType: "atlassian" },
          project: { key: "PAY" },
          created: "2026-10-01T00:00:00.000+0000",
          updated: "2026-10-05T00:00:00.000+0000"
        }
      })
    }
    if (url.startsWith("https://acme.atlassian.net/rest/api/3/issue/PAY-311/comment")) {
      return ok({
        comments: [
          { id: "1", author: { accountId: "acc-eve", accountType: "atlassian" }, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Make it 30?" }] }] }, created: "2026-10-02T00:00:00.000+0000" },
          { id: "2", author: { accountId: "acc-bot", accountType: "app" }, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Auto-triaged." }] }] }, created: "2026-10-03T00:00:00.000+0000" }
        ]
      })
    }
    if (url.includes("/issue/PAY-999")) return { status: 404, body: { errorMessages: ["Issue does not exist or you do not have permission to see it."] } }
    return undefined
  }

  it("reads summary, description and comments with their authors", async () => {
    const s = Either.getOrThrow(await resolve("jira:PAY-311", handler))
    expect(s.text).toBe("Refund window Refunds are allowed within 14 days. Make it 30? Auto-triaged.")
    expect(authorOf(s, "Refunds are allowed")).toBe("acc-pat")
    expect(authorOf(s, "Make it 30?")).toBe("acc-eve")
    expect(s.attribution.find((a) => s.text.slice(a.start, a.end) === "Auto-triaged.")?.bot).toBe(true)
    expect(s.container).toBe("project/PAY")
    expect(s.uri).toBe("https://acme.atlassian.net/browse/PAY-311")
  })

  it("maps missing issues, and asks for a baseUrl when none is set", async () => {
    expect(Either.flip(await resolve("jira:PAY-999", handler)).pipe(Either.getOrThrow)._tag).toBe("NotFound")
    const bare = Either.flip(await resolve("jirabare:PAY-311", handler)).pipe(Either.getOrThrow)
    expect(bare.message).toContain('set "baseUrl" on the jira resolver')
  })
})

describe("google docs", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
  const handler = (url: string, req: HttpRequest) => {
    if (url.startsWith(`https://docs.googleapis.com/v1/documents/${id}`)) {
      return ok({
        documentId: id,
        title: "Refund policy",
        revisionId: "rev-7",
        tabs: [{ documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: "Refunds are processed within 14 days.\n" } }] } }] } } }]
      })
    }
    if (url.startsWith(`https://www.googleapis.com/drive/v3/files/${id}/comments`)) {
      expect(req.toolkit).toBe("googledrive")
      return ok({
        comments: [
          {
            id: "c1",
            content: "Should this be 30 days?",
            author: { emailAddress: "eve@acme.com" },
            createdTime: "2026-10-02T00:00:00Z",
            replies: [{ id: "r1", content: "No, 14 days is final.", author: { emailAddress: "Pat@acme.com" }, createdTime: "2026-10-03T00:00:00Z" }]
          },
          { id: "c2", content: "old", deleted: true, author: { emailAddress: "eve@acme.com" } }
        ]
      })
    }
    if (url.startsWith(`https://www.googleapis.com/drive/v3/files/${id}`)) {
      expect(req.hostOverride).toBe(true)
      return ok({ owners: [{ emailAddress: "pat@acme.com" }], parents: ["folder-policies"], webViewLink: `https://docs.google.com/document/d/${id}/edit` })
    }
    return { status: 404, body: { error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." } } }
  }

  it("attributes the body to the owner and comments to their authors, as emails", async () => {
    const s = Either.getOrThrow(await resolve(`gdocs:${id}`, handler))
    expect(s.text).toBe("Refund policy Refunds are processed within 14 days. Should this be 30 days? No, 14 days is final.")
    expect(authorOf(s, "Refunds are processed")).toBe("pat@acme.com")
    expect(authorOf(s, "Should this be")).toBe("eve@acme.com")
    expect(authorOf(s, "14 days is final")).toBe("pat@acme.com")
    expect(s.creator).toEqual({ system: "email", account: "pat@acme.com" })
    expect(s.container).toBe("folder/folder-policies")
  })

  it("still resolves when Drive is not connected, without authors", async () => {
    const docsOnly = (url: string, req: HttpRequest) =>
      url.startsWith("https://www.googleapis.com/") ? { status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "no" } } } : handler(url, req)
    const s = Either.getOrThrow(await resolve(`gdocs:${id}`, docsOnly))
    expect(s.text).toBe("Refund policy Refunds are processed within 14 days.")
    expect(s.creator).toBeUndefined()
  })
})
