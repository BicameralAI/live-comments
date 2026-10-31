import { arr, rec, str } from "./provider.js"

// Step 1 of normalization (spec §6.2) for each provider's rich format: drop the
// markup, keep the words. Blocks are separated by newlines, which normalization
// later collapses to spaces.

/** Atlassian Document Format (Jira, Confluence). */
export const adfToText = (node: unknown): string => {
  const n = rec(node)
  if (!n) return typeof node === "string" ? node : ""
  switch (str(n.type)) {
    case "text":
      return str(n.text) ?? ""
    case "hardBreak":
      return "\n"
    case "mention":
      return str(rec(n.attrs)?.text) ?? ""
    case "emoji":
      return str(rec(n.attrs)?.text) ?? str(rec(n.attrs)?.shortName) ?? ""
    case "inlineCard":
    case "blockCard":
      return str(rec(n.attrs)?.url) ?? ""
    default: {
      const inner = arr(n.content).map(adfToText)
      const inline = ["paragraph", "heading", "listItem", "tableCell", "tableHeader", "codeBlock", "blockquote"].includes(str(n.type) ?? "")
      return inline ? inner.join("") + "\n" : inner.join("\n")
    }
  }
}

/** Notion rich text arrays. */
export const notionRichText = (v: unknown): string => arr(v).map((t) => str(rec(t)?.plain_text) ?? "").join("")

/** Slack mrkdwn: links keep their label, mentions keep their id, formatting marks go. */
export const slackToText = (s: string): string =>
  s
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g, "@$1")
    .replace(/<#([A-Z0-9]+)\|([^>]*)>/g, "#$2")
    .replace(/<!(?:subteam\^[A-Z0-9]+\|)?([^>]+)>/g, "@$1")
    .replace(/(^|\s)[*_~]([^*_~\n]+)[*_~](?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/```([\s\S]*?)```/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

/** Google Docs structural elements, including tables and tabs. */
export const gdocsToText = (content: unknown): string =>
  arr(content)
    .map((el) => {
      const e = rec(el)
      const para = rec(e?.paragraph)
      if (para) return arr(para.elements).map((x) => str(rec(rec(x)?.textRun)?.content) ?? "").join("")
      const table = rec(e?.table)
      if (table) {
        return arr(table.tableRows)
          .map((row) => arr(rec(row)?.tableCells).map((cell) => gdocsToText(rec(cell)?.content)).join("\n"))
          .join("\n")
      }
      const toc = rec(e?.tableOfContents)
      if (toc) return gdocsToText(toc.content)
      return ""
    })
    .join("")
