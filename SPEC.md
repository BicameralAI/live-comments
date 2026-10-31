# Live Comments — draft specification

**Status:** draft v0.1 · 2026-10-30 · BicameralAI
**Scope of this draft:** TypeScript reference implementation, repository and GitHub sources only.

---

## 1. Problem

Business rules in code rarely say where they came from. A function decides that discount codes don't stack, that refunds round half-up, that a trial lasts 14 days. The decision was made somewhere: a ticket, a contract clause, a meeting. Or it was never made, and whoever wrote the code (increasingly, an agent) settled it on the spot.

Tests can't tell these cases apart. A rule that nobody decided passes just as well as one that was signed off. Comments don't help either, because a comment is a claim nobody checks. It goes stale silently.

## 2. Idea

A **live comment** is a code comment that cites its source with a verbatim quote, and that a checker keeps honest:

```ts
/**
 * @source gh:acme/shop#142 "Only the best single discount applies per order"
 * @source file:decisions/0007-discounts.md "Discounts are not cumulative"
 */
export function applyDiscounts(codes: Code[]): Price { … }
```

The checker verifies that each quote still appears in its source, that the source has been ratified rather than merely proposed, and that business logic in governed areas cites something. Code that cites nothing is not treated as wrong. It is reported as an **open question** with an owner, until a person with standing closes it.

## 3. Principles

1. **Track authority; never grant it.** The annotations record that a rule needs a source and whether one exists. Nothing in the code can ratify a source or name who may. Ratification is an act that happens outside the program (in v0, an approved pull request).
2. **Quotes, not links.** A link only proves that a page exists. A verbatim quote lets the checker confirm, without a model, that the cited text is actually there.
3. **Deterministic first.** Every v0 check is deterministic and reproducible. Whether a quote *supports* the code is a semantic judgment; when added, it is advisory and never turns a check green.
4. **Uncited is open, not illegal.** Missing support is surfaced as a question with an owner, not suppressed and not guessed.
5. **Offline check, online sync.** Compiling never touches the network. External sources are snapshotted into a committed lockfile, and refreshing that lockfile is a separate, explicit step.

## 4. Annotations

Annotations are JSDoc tags. They attach to the declaration that immediately follows the comment block, using JSDoc's usual attachment rules. JSDoc is used instead of decorators because decorators only apply to classes and class members, while business rules mostly live in plain functions and constants.

### 4.1 `@source`

```
@source <ref> "<quote>"
```

- `<ref>` identifies a source (§6). A declaration may carry several `@source` tags.
- `<quote>` must occur verbatim in the source after normalization: Unicode NFC, runs of whitespace collapsed to one space, leading and trailing whitespace trimmed. Matching is case-sensitive. Ellipses and paraphrase are not supported in v0.

### 4.2 `@open`

```
@open "<question>"
```

Declares, deliberately, that a rule is not yet decided. An `@open` declaration passes the coverage check (§5) and is listed in every report until it is replaced by a `@source` that points at ratified material.

*Future:* distinguish a **parked** question (no one may choose yet) from a **permission** (the source explicitly allows either reading, so the implementer may choose). v0 has only `@open`.

## 5. Governed areas

Not all code needs citations. Requiring them everywhere produces junk citations written only to silence the checker. Projects declare **governed areas** in `live-comments.config.json`:

```json
{
  "governed": ["src/checkout/**", "src/billing/**"],
  "sources": { "file": { "root": "decisions/" }, "gh": { "repos": ["acme/shop"] } },
  "unratified": "warn"
}
```

In a governed area, every exported function, class and top-level constant must carry at least one `@source` or `@open`.

## 6. Sources and ratification

### 6.1 Reference schemes (v0)

| Scheme | Example | Text checked | Status |
|---|---|---|---|
| `file:` | `file:decisions/0007-discounts.md` | file body | from frontmatter (§6.2) |
| `gh:` | `gh:acme/shop#142` | issue body and comments | `proposed` (§6.3) |

Reserved for later versions: `linear:`, `notion:`, `slack:`, `contract:`, and a single `ledger:` scheme that resolves all of them through one service.

### 6.2 Ratified decision files

A decision file carries frontmatter:

```yaml
---
status: proposed | ratified | superseded
superseded_by: 0012-discounts-v2.md   # when superseded
---
```

A `ratified` status counts **only if** the commit that set it was merged through a pull request approved by a code owner of the decisions directory, under branch protection. The approval is the ratifying act. Because an agent cannot produce that approval, it cannot ratify its own sources. If the status was set any other way, the checker treats it as `proposed`.

### 6.3 Issues

Issue text is treated as `proposed`. An issue records what someone asked for, not what was agreed. To rely on it as ratified, the project writes a decision file that quotes the issue and ratifies it (§6.2).

### 6.4 Who may close an open question

The code never names a person. In v0, standing comes from the decisions directory's code owners, optionally scoped by subdirectory (`decisions/pricing/` → pricing owners). Reports show that owner next to each `@open`. Planned: a default owner derived from the cited source itself. When the sources conflict, or no one clearly owns the area, "who decides" is reported as an open question of its own.

## 7. Lockfile

`live-comments.lock.json` is committed. It holds one entry per distinct ref:

```json
{
  "gh:acme/shop#142": {
    "fetched_at": "2026-10-30T14:02:11Z",
    "version": "issue:updated_at=2026-10-03T09:12:40Z",
    "text_sha256": "…",
    "text": "…normalized snapshot…",
    "status": "proposed"
  },
  "file:decisions/0007-discounts.md": {
    "version": "git:3f9c2e1",
    "text_sha256": "…",
    "status": "ratified",
    "ratified_by": { "pr": 88, "approver": "…" }
  }
}
```

The lockfile stores the snapshot text so that `check` can verify quotes offline. When a source changes upstream, the change appears as a lockfile diff in a pull request and can be reviewed like a dependency bump.

## 8. Commands

| Command | Network | Purpose |
|---|---|---|
| `live-comments check` | none | Parse annotations and verify them against the lockfile. Deterministic; intended for every save and for CI. |
| `live-comments sync` | yes | Re-fetch every referenced source, update the lockfile, and report what changed. Run on demand, nightly, or on PRs. |
| `live-comments report` | none | List open questions and their owners, plus coverage per governed area. |

### 8.1 Diagnostics

| Code | Severity | Raised by | Meaning |
|---|---|---|---|
| LC001 | error | check | Malformed annotation |
| LC002 | error | check | Quote not found in the locked snapshot |
| LC003 | error | check | Ref missing from the lockfile; run `sync` |
| LC004 | error | check | Export in a governed area has no `@source` or `@open` |
| LC005 | warn* | check | Cited source is `proposed` or `superseded`, not `ratified` |
| LC006 | error | sync | Stale: the quote no longer appears in the current source |
| LC007 | error | sync | Source unreachable or access denied |
| LC100 | info | check, report | Open question, with its owner |

\* LC005's severity is set by `unratified` in the config.

## 9. Packaging

- **CLI** built on the TypeScript compiler API. This is the authoritative checker.
- **ESLint rule** wrapping `check`, for existing CI pipelines.
- **Editor plugin** (later): hovers that show each quote and its status, and a "cite from linked issue" quick fix. TypeScript language-service plugins affect only the editor and cannot fail `tsc`, so enforcement belongs in the CLI or lint, not in a compiler plugin.
- The annotation grammar (§4) and lockfile format (§7) are meant to be language-neutral. TypeScript is the reference implementation.

## 10. Non-goals for v0

- Checking whether a quote semantically supports the code
- Sources other than repository files and GitHub issues
- Languages other than TypeScript
- Detecting uncited logic beyond the governed-export rule
- Runtime behavior for open questions

## 11. Open design questions

1. **Noise.** Should citations live inline, or in a sidecar file keyed by symbol, with inline tags optional? Inline citations are visible where the code is read; a sidecar keeps the code clean.
2. **Citation laundering.** An agent pressured to satisfy LC004 can cite a nearby but irrelevant quote. Deterministic checks catch missing and misquoted citations, not irrelevant ones. What advisory signal is cheap enough to run on every PR?
3. **Runtime semantics of open questions.** When an `@open` rule must run, should it fail closed, run a default explicitly marked provisional, or run every reading and log where they disagree?
4. **Ratification outside Git.** How do contracts, tickets and meeting decisions get an unforgeable ratifying act without moving everything into pull requests?
5. **Quote normalization.** Markdown rendering, smart quotes, and text that spans an edit boundary.

## 12. Related work

- **Requirements tracing tools** such as StrictDoc (`@relation` markers in source) and OpenFastTrace link code to requirements kept in a controlled document. They assume the requirements are already approved, and they do not verify quotes.
- **Spec-driven AI development** (Kiro, Spec Kit, Tessl) keeps specs next to code as the agent's input. The Spec Growth Engine (Grabowski, arXiv:2606.27045) adds a blocking merge gate on spec–code drift and treats code with no owning spec as an error. Specs there live in the repository and can be written in the same commit as the code they justify.
- **AsDecided** proposes that agents cite architectural decisions by id, revision and status in plans and pull requests, with a checker confirming each record exists and applies.

Live Comments differs in four places: citations are verbatim quotes checked against external sources; the cited source's ratification status is part of the check; ratification is an act the code author cannot perform; and uncited logic is reported as an open question with an owner.

## 13. Milestone 0

Run the checker on one real codebase and report the share of exported functions in governed areas that cite no source. That number is the first result.
