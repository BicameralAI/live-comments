# live-comments

Code comments that cite where a rule came from, and a checker that keeps them honest.

```ts
/**
 * @source linear:ENG-142 "Only the best single discount applies per order" by pricing-call
 */
export function applyDiscounts(codes: Code[]): Price { … }

/** @open "Do discount codes stack with gift cards?" by pricing-call */
export function applyGiftCard(card: GiftCard, total: Price): Price { … }
```

A `@source` needs only a ref. Add a verbatim quote and the checker confirms the words are still there. Add `by` and it confirms they were written by someone your team named for that kind of decision. A rule nobody has decided is marked `@open`, a question addressed to the people who can answer it.

Who counts as `pricing-call` is defined once, in a governed `AUTHORITY` file of names for people, places and authorities. Sources are reached through a small resolver contract, with GitHub, Linear, Notion, Jira and Google Docs available through Nango. Coding agents read sources through the same path the checker uses, and a shipped agent skill teaches them when and how to annotate.

**Status:** draft specification, no implementation yet. Read [SPEC.md](SPEC.md).

**Setup (planned):** tell your coding agent "set up live-comments from github.com/BicameralAI/live-comments", or run `npx live-comments init` yourself. The skill is in [skills/live-comments/SKILL.md](skills/live-comments/SKILL.md).

Feedback is welcome in issues.
