# live-comments

Code comments that cite where a rule came from, and a checker that keeps them honest.

```ts
/**
 * @source gh:acme/shop#142 "Only the best single discount applies per order"
 */
export function applyDiscounts(codes: Code[]): Price { … }
```

A live comment quotes its source verbatim. The checker confirms the quote is still there, that the source was ratified and not just proposed, and that business logic in governed areas cites something. Logic that cites nothing is reported as an open question, with the person who can close it.

**Status:** draft specification, no implementation yet. Read [SPEC.md](SPEC.md).

Feedback is welcome in issues.
