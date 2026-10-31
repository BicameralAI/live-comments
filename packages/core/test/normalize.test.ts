import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { normalizeSegments, normalizeText, occurrences, stripMarkdown } from "../src/normalize.js"

const text = fc.string({ unit: fc.constantFrom("a", "b", " ", "\n", "\t", "’", "“", "é", "x") })
const segment = fc.record({ text, author: fc.option(fc.constantFrom("pm", "eng"), { nil: undefined }) })

describe("normalizeText", () => {
  it("is idempotent", () => {
    fc.assert(fc.property(text, (s) => normalizeText(normalizeText(s)) === normalizeText(s)))
  })

  it("leaves no curly quotes, runs of whitespace, or edge whitespace", () => {
    fc.assert(
      fc.property(text, (s) => {
        const n = normalizeText(s)
        return !/[‘’“”]/.test(n) && !/\s\s/.test(n) && n === n.trim() && !/[\n\t]/.test(n)
      })
    )
  })

  it("composes to NFC", () => {
    expect(normalizeText("café")).toBe("café")
    expect(normalizeText("“Codes don’t stack”")).toBe('"Codes don\'t stack"')
  })
})

describe("normalizeSegments", () => {
  it("produces spans that tile the text in order, each holding its segment's words", () => {
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 8 }), (segs) => {
        const n = normalizeSegments(segs.map((s) => ({ text: s.text, ...(s.author ? { author: { system: "github", account: s.author } } : {}) })))
        const nonEmpty = segs.filter((s) => normalizeText(s.text).length > 0)
        expect(n.attribution.length).toBe(nonEmpty.length)
        let cursor = 0
        n.attribution.forEach((span, i) => {
          expect(span.start).toBe(i === 0 ? 0 : cursor + 1)
          expect(n.text.slice(span.start, span.end)).toBe(normalizeText(nonEmpty[i]!.text))
          expect(span.author?.account).toBe(nonEmpty[i]!.author)
          cursor = span.end
        })
        expect(cursor).toBe(n.text.length)
      })
    )
  })

  it("is stable: normalizing the normalized text changes nothing", () => {
    fc.assert(fc.property(fc.array(segment, { maxLength: 6 }), (segs) => {
      const n = normalizeSegments(segs)
      return normalizeText(n.text) === n.text
    }))
  })

  it("finds every quote copied from its own output", () => {
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 6 }), fc.nat(), fc.nat(), (segs, a, b) => {
        const n = normalizeSegments(segs)
        if (n.text.length === 0) return true
        const i = a % n.text.length
        const j = i + 1 + (b % (n.text.length - i))
        const quote = n.text.slice(i, j)
        const q = normalizeText(quote)
        return q.length === 0 || occurrences(n.text, q).length > 0
      })
    )
  })
})

describe("stripMarkdown", () => {
  it("keeps words and link text, drops markup and link targets", () => {
    const md = "## Decision\n\n- **Codes** do *not* stack. See [the policy](https://x.example/p).\n> `max 1`"
    expect(normalizeText(stripMarkdown(md))).toBe("Decision Codes do not stack. See the policy. max 1")
  })

  it("keeps snake_case and arithmetic intact", () => {
    expect(normalizeText(stripMarkdown("use max_discount_rate and 2 * 3 * 4"))).toBe("use max_discount_rate and 2 * 3 * 4")
  })
})
