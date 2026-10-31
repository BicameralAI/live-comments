# live-comments

Code comments that cite where a rule came from, and a checker that keeps them honest.

```ts
/**
 * @source linear:ENG-142 "Only the best single discount applies per order"
 */
export function applyDiscounts(codes: Code[]): Price { … }
```

A live comment quotes its source verbatim. The checker confirms the quote is still there, that the quoted words were written by someone authorized to decide that code, and that business logic in governed areas cites something. Logic that cites nothing is reported as an open question, with the people who can close it. Sources plug in through a small resolver contract; external tools such as GitHub, Linear, Notion, Jira and Google Docs are reached through Nango by default. Agents read sources through the same path the checker uses, so a quote is always checked against the text its author saw.

**Status:** draft specification, no implementation yet. Read [SPEC.md](SPEC.md).

Feedback is welcome in issues.
