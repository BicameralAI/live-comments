# live-comments

Code comments that cite where a rule came from, and a checker that keeps them honest.

```ts
/**
 * @source linear:ENG-142 "Only the best single discount applies per order"
 */
export function applyDiscounts(codes: Code[]): Price { … }
```

A live comment quotes its source verbatim. The checker confirms the quote is still there, that the source was ratified by its owner and not just proposed, and that business logic in governed areas cites something. Logic that cites nothing is reported as an open question, with the people who can close it. Sources plug in through a small resolver contract, so any system that can serve a document by reference, including any MCP server, can be cited.

**Status:** draft specification, no implementation yet. Read [SPEC.md](SPEC.md).

Feedback is welcome in issues.
