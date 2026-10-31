import { describe, expect, it } from "vitest"
import { parseFile, parseOpenBody, parseSourceBody } from "../src/annotations/parse.js"
import { print } from "../src/authority/syntax.js"

describe("@source", () => {
  it("needs only a ref", () => {
    expect(parseSourceBody("linear:ENG-142", 1)).toMatchObject({ ref: "linear:ENG-142" })
    expect(parseSourceBody("linear:ENG-142", 1).quote).toBeUndefined()
  })

  it("takes an optional quote and by", () => {
    const a = parseSourceBody('github:acme/shop#12 "Codes do not stack" by pricing-call', 1)
    expect(a).toMatchObject({ ref: "github:acme/shop#12", quote: "Codes do not stack" })
    expect(print(a.authority!)).toBe("pricing-call")
  })

  it("folds in into by, as sticky arguments are written", () => {
    expect(print(parseSourceBody("linear:ENG-1 by pricing | legal in linear:team/PRICING", 1).authority!)).toBe("(pricing | legal) in linear:team/PRICING")
  })

  it("rejects a missing ref", () => {
    expect(() => parseSourceBody('"just a quote"', 1)).toThrow(/needs a ref/)
  })
})

describe("@open", () => {
  it("needs only a question", () => {
    expect(parseOpenBody('"Do codes stack?"', 1)).toMatchObject({ question: "Do codes stack?", options: [] })
  })

  it("accepts every optional part in any order", () => {
    const a = parseOpenBody('checkout.stacking "Do codes stack?" options "yes" | "no" in linear:team/PRICING by pricing', 1)
    expect(a).toMatchObject({ id: "checkout.stacking", question: "Do codes stack?", options: ["yes", "no"] })
    expect(print(a.authority!)).toBe("pricing in linear:team/PRICING")
  })

  it("uses anyone when only in is given", () => {
    expect(print(parseOpenBody('"q" in github:acme/shop#3', 1).authority!)).toBe("anyone in github:acme/shop#3")
  })

  it("rejects a missing question", () => {
    expect(() => parseOpenBody("by pricing", 1)).toThrow(/needs a question/)
  })
})

describe("parseFile", () => {
  const code = `
import x from "y"

/**
 * Applies discounts.
 * @source linear:ENG-142 "Only the best single discount
 *   applies per order" by pricing-call
 * @param codes the codes
 */
export function applyDiscounts(codes: string[]) { return codes }

/** @open "Do codes stack with gift cards?" by pricing */
export const applyGiftCard = () => 0

function internal() {}

/** @source oops */
export class Broken {}
`
  const f = parseFile("src/checkout.ts", code)

  it("finds declarations with their annotations and lines", () => {
    expect(f.declarations.map((d) => [d.name, d.exported, d.annotations.length])).toEqual([
      ["applyDiscounts", true, 1],
      ["applyGiftCard", true, 1],
      ["internal", false, 0],
      ["Broken", true, 0]
    ])
    const src = f.declarations[0]!.annotations[0]!
    expect(src).toMatchObject({ kind: "source", line: 6, quote: "Only the best single discount applies per order" })
  })

  it("reports malformed tags without losing the rest", () => {
    expect(f.problems).toEqual([{ file: "src/checkout.ts", line: 17, message: "@source: @source needs a ref such as linear:ENG-142" }])
  })
})
