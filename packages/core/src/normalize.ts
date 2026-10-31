import { createHash } from "node:crypto"
import type { Segment, Span } from "./domain.js"

// Normalization (spec §6.2). The same steps apply to every source and every
// quote, so a quote copied from `read` output always matches.

const SINGLE_QUOTES = /[‘’‚‛′]/g
const DOUBLE_QUOTES = /[“”„‟″]/g
const WHITESPACE = /\s+/g

/** Steps 2 and 3: NFC, straight quotes, collapsed whitespace. */
export const normalizeText = (s: string): string =>
  s.normalize("NFC").replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"').replace(WHITESPACE, " ").trim()

/** Step 1 for Markdown: drop markup, keep words. Link text stays; targets go. */
export const stripMarkdown = (md: string): string =>
  md
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")

export interface Normalized {
  readonly text: string
  readonly attribution: ReadonlyArray<Span>
}

/**
 * Normalize each segment and join them with a single space. Attribution
 * offsets come from the concatenation, so they always line up with the text.
 */
export const normalizeSegments = (segments: ReadonlyArray<Segment>): Normalized => {
  let text = ""
  const attribution: Array<Span> = []
  for (const seg of segments) {
    const t = normalizeText(seg.text)
    if (t.length === 0) continue
    if (text.length > 0) text += " "
    const start = text.length
    text += t
    attribution.push({
      start,
      end: text.length,
      ...(seg.author ? { author: seg.author } : {}),
      ...(seg.bot ? { bot: true } : {}),
      ...(seg.createdAt ? { createdAt: seg.createdAt } : {}),
      ...(seg.id ? { id: seg.id } : {})
    })
  }
  return { text, attribution }
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

/** Every start offset at which `needle` occurs in `haystack`. */
export const occurrences = (haystack: string, needle: string): ReadonlyArray<number> => {
  const out: Array<number> = []
  if (needle.length === 0) return out
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    out.push(i)
    i = haystack.indexOf(needle, i + 1)
  }
  return out
}

/** Spans overlapping [start, end). */
export const spansIn = (attribution: ReadonlyArray<Span>, start: number, end: number): ReadonlyArray<Span> =>
  attribution.filter((s) => s.start < end && s.end > start)
