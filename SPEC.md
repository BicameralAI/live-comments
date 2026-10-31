# Live Comments — draft specification

**Status:** draft v0.1 · 2026-10-30 · BicameralAI
**Scope of this draft:** TypeScript reference implementation, built on Effect. Sources plug in through a resolver contract (§6); external tools are reached through Nango by default.

---

## 1. Problem

Business rules in code rarely say where they came from. A function decides that discount codes don't stack, that refunds round half-up, that a trial lasts 14 days. The decision was made somewhere: a ticket, a contract clause, a meeting. Or it was never made, and whoever wrote the code (increasingly, an agent) settled it on the spot.

Tests can't tell these cases apart. A rule that nobody decided passes just as well as one that was signed off. Comments don't help either, because a comment is a claim nobody checks. It goes stale silently.

## 2. Idea

A **live comment** is a code comment that cites its source with a verbatim quote, and that a checker keeps honest:

```ts
/**
 * @source linear:ENG-142 "Only the best single discount applies per order"
 * @source file:docs/pricing-policy.md "Discounts are not cumulative"
 */
export function applyDiscounts(codes: Code[]): Price { … }
```

The checker verifies that each quote still appears in its source, that the quoted words were written by someone authorized to decide that code, and that business logic in governed areas cites something. Code that cites nothing is not treated as wrong. It is reported as an **open question**, with the people who can close it.

## 3. Principles

1. **Track authority; never grant it.** The annotations record which words a rule rests on. Who may decide each area of code is declared outside the code, in a governed authority file, and checked against who actually wrote the quoted words (§6.5). Nothing in the code can grant authority.
2. **Quotes, not links.** A link only proves that a page exists. A verbatim quote lets the checker confirm, without a model, that the cited text is actually there.
3. **Deterministic first.** Every v0 check is deterministic and reproducible. Whether a quote *supports* the code is a semantic judgment; when added, it is advisory and never turns a check green.
4. **Uncited is open, not illegal.** Missing support is surfaced as a question with an owner, not suppressed and not guessed.
5. **Offline check, online sync.** Compiling never touches the network. External sources are snapshotted into a committed lockfile, and refreshing that lockfile is a separate, explicit step.
6. **One read path.** Whoever writes a citation, person or agent, reads the source through the same resolver and normalization the checker uses (§6.2). A quote is therefore always checked against exactly the text its author saw.

## 4. Annotations

Annotations are JSDoc tags. They attach to the declaration that immediately follows the comment block, using JSDoc's usual attachment rules. JSDoc is used instead of decorators because decorators only apply to classes and class members, while business rules mostly live in plain functions and constants.

### 4.1 `@source`

```
@source <ref> "<quote>"
```

- `<ref>` identifies a source (§6). A declaration may carry several `@source` tags.
- `<quote>` must occur verbatim in the source's normalized text (§6.2). The same normalization is applied to the quote. Matching is case-sensitive. Ellipses and paraphrase are not supported in v0.
- A quote corresponds to the `exact` field of a W3C Web Annotation `TextQuoteSelector`. When a quote occurs more than once in a source, a later version may accept `prefix` and `suffix` to tell the occurrences apart, as that selector does.

### 4.2 `@open`

```
@open [<id>] "<question>"
```

Declares, deliberately, that a rule is not yet decided. An `@open` declaration passes the coverage check (§5) and is listed in every report until it is replaced by a `@source` whose quoted words come from someone authorized to decide it.

Code never names who may fill an opening. That is set in the governed owners file (§6.7), by path or by `<id>`. The optional `<id>` (for example `checkout.discount-stacking`) is needed only when one opening must have different owners from the rest of its path. The id is the only link between the comment and its owners entry. Tooling resolves the id to that entry's current line, so the link survives edits to either file.

*Future:* distinguish a **parked** question (no one may choose yet) from a **permission** (the source explicitly allows either reading, so the implementer may choose). v0 has only `@open`.

## 5. Governed areas

Not all code needs citations. Requiring them everywhere produces junk citations written only to silence the checker. Projects declare **governed areas** in `live-comments.config.json`:

```json
{
  "governed": ["src/checkout/**", "src/billing/**"]
}
```

Sources are configured separately (§6.1). In a governed area, every exported function, class and top-level constant must carry at least one `@source` or `@open`.

## 6. Sources and authority

Live Comments does not ship a fixed list of integrations. Any system can be a source if it implements the resolver contract below. The checker knows only the contract.

### 6.1 Refs

A ref is a URI. Its scheme selects a resolver configured in `live-comments.config.json`:

```json
{
  "resolvers": {
    "file":   { "builtin": "file", "root": "." },
    "linear": { "nango": { "integration": "linear", "connection": "acme-prod" } },
    "notion": { "nango": { "integration": "notion", "connection": "acme-prod" } }
  }
}
```

### 6.2 The resolver contract

A **text resolver** answers one question: what does this ref say now?

```
resolve(ref) → { uri, text, version, retrieved_at, container, attribution }
             | { error: "not_found" | "denied" | "unreachable" }
```

- `text` is the source's full current text, normalized as below. A resolver must not summarize or excerpt it.
- `version` must change whenever `text` changes. A provider's etag, an `updated_at` timestamp or a commit hash all qualify. If the provider offers none, `version` is the SHA-256 of `text`.
- A resolver that must redact content (for example, to strip personal data) reports `redacted: true`. A quote that falls inside redacted text cannot be verified and is reported as LC008.
- Resolution must be read-only. A resolver never writes to its source.
- `container` names where the source lives in its own system: a Linear team, a Notion space, a GitHub repository, a Drive folder. Authority rules can restrict which containers count (§6.5).
- `attribution` maps spans of the normalized `text` to the accounts that wrote them: `[{ start, end, author: { system, account } }]` (§6.3).

**Normalization.** Every resolver produces plain text the same way, and the same steps are applied to every quote:

1. Convert the provider's rich format to plain text: Markdown, Atlassian Document Format and Notion blocks lose their markup and keep their words. Link text is kept and link targets are dropped.
2. Apply Unicode NFC, and replace curly quotes and apostrophes with straight ones.
3. Collapse runs of whitespace to one space and trim the ends.

**Agents use the same path.** Principle 6 is enforced by giving authors no reason to read a source any other way. `live-comments read <ref>` and the `read_source` tool of `live-comments mcp` (§8) resolve a source, normalize it, record the snapshot in the lockfile, and return the normalized text. An agent configured with that tool quotes from the text the checker will verify. A quote copied from a different rendering, such as a web page or another MCP server, may not match and is reported as LC002.

### 6.3 Attribution

Authority attaches to the person whose words are quoted, not to whoever owns the ticket or document as a whole. A ticket's description may be the product manager's while a comment under it is an engineer's guess, and quoting each carries different weight.

The checker finds the quote in the normalized text and reads the author of that span from `attribution`:

- **Comments and messages** are attributed to their authors.
- **Ticket and document bodies** are attributed to their creators, as the provider reports them.
- **Repository files** are attributed line by line to the commit author, as `git blame` reports it.

A quote that spans text by several authors is attributed to all of them, and each must be authorized. A span with no author is reported as LC013.

### 6.4 Bindings

| Binding | Supplies | How |
|---|---|---|
| `builtin: file` | text, attribution | Reads files in the repository at the current commit, attributed line by line with `git blame`. |
| `nango` | text, attribution | The default for external tools. Fetches the provider's API through a Nango proxy, which handles OAuth, token refresh and rate limits, then converts the response to text with a per-provider extractor. |

**Why Nango.** Most of the work in an integration is authentication: OAuth flows, token refresh and per-provider quirks. Nango's proxy covers that for several hundred APIs and returns the provider's raw responses, so Live Comments controls exactly how text is extracted. The extractors are small, pure functions from an API response to normalized text and its attribution, one per provider. v0 ships extractors for GitHub, Linear, Notion, Jira and Google Docs.

Live Comments needs only Nango's Auth and Proxy features, which are exactly what Nango's free self-hosted option includes. Projects should know two things before choosing a deployment. Nango Cloud routes source text, including tickets and contracts, through a third party. Nango is licensed under the Elastic License 2.0, which permits self-hosting for internal use but is not an open-source license.

*Later versions:* a `command` binding (an executable speaking the contract as JSON over stdin and stdout) and an `mcp` binding, for sources Nango does not cover.

### 6.5 Authority

In a governed area, every `@source` must quote words written by a principal authorized for that code, and an `@open` can be filled only by such a source (LC009). Who is authorized is declared in governed files outside the code (§6.6, §6.7). Like CODEOWNERS, they take effect only once merged through a reviewed pull request, so an agent can write citations and openings freely but cannot decide whose words count.

Live Comments does not record approval or sign-off. It checks who wrote the words a rule rests on, not whether anyone later endorsed them.

Reports show, next to each `@open`, the principals who can fill it. When no rule covers a governed scope, or a quote's author cannot be mapped to a principal, "who decides" is reported as an open question in its own right instead of being guessed.

### 6.6 Identity

The same person appears as different accounts in different systems: a GitHub login, a Linear user, a Slack member ID, an email address on a contract. Checking an opening's owners (§6.7) against a source's `owners` therefore needs a map from accounts to people.

`live-comments.identities.json` defines **principals**, each a person or a group, and the external accounts that belong to them:

```json
{
  "pricing-lead": { "accounts": [ { "system": "github", "account": "jdoe" },
                                  { "system": "linear", "account": "usr_8f2…" },
                                  { "system": "email",  "account": "jdoe@acme.com" } ] },
  "pricing":      { "members": ["pricing-lead", "finance-ops"] }
}
```

- **The identity file confers authority, so it is governed like CODEOWNERS.** A mapping counts only if it was merged through a pull request approved by the file's code owners. Otherwise anyone could gain standing by adding their own account to a principal.
- **Matching is assisted, not automatic.** `live-comments identities suggest` proposes mappings, for example from verified emails that several systems share. It writes proposals only, and a person approves them.
- **Unmapped accounts have no authority.** Words written by an account that maps to no principal can be cited outside governed areas, but not inside them (LC010).
- **Agents never hold authority.** Accounts used by coding agents and bots are marked as such, and words they wrote never satisfy the authority check, even when written under a person's credentials that the provider can tell apart.
- **Directories can replace the file.** A project with an identity provider that supports SCIM, or a ledger that already resolves identities, can configure it as the identity source. The file is the fallback for projects without one.

### 6.7 Owners of open questions

`live-comments.owners.json` says whose words may bind each area of code. It is governed like the identity file: an entry counts only if it was merged through a pull request approved by the file's code owners. An agent can therefore write `@open` freely but cannot choose who settles it.

```json
{
  "paths": {
    "src/checkout/**": ["pricing"],
    "src/billing/refunds/**": ["finance-ops", "pricing-lead"]
  },
  "openings": {
    "checkout.discount-stacking": ["pricing-lead"]
  }
}
```

- An `@open` with an id uses its `openings` entry. Otherwise the most specific matching `paths` glob applies.
- Every `@source` in the scope must quote words written by one of that entry's principals, and an `@open` there can be filled only by such a quote (LC009).

**Keeping code and owners file in sync.** Line numbers are never stored, because they drift with every edit. The id is the reference, and the line is computed:

- `check` reports an `@open` id with no `openings` entry (LC011) and an `openings` entry that no `@open` uses (LC012). Together these catch a rename made on one side only.
- `live-comments rename <old> <new>` renames an id in the code and in the owners file in one change.
- The editor plugin resolves an id to its entry's current line, for go-to-definition and for a hover showing the owners. `report` prints the same location (`live-comments.owners.json:9`), so links in CI output point at the right line.

## 7. Lockfile

`live-comments.lock.json` is committed. It holds one entry per distinct ref:

```json
{
  "linear:ENG-142": {
    "uri": "https://linear.app/acme/issue/ENG-142",
    "resolver": "nango:linear",
    "retrieved_at": "2026-10-30T14:02:11Z",
    "version": "updated_at=2026-10-03T09:12:40Z",
    "container": "team/PRICING",
    "text_sha256": "…",
    "text": "…normalized snapshot…",
    "attribution": [
      { "start": 0,   "end": 412, "author": { "system": "linear", "account": "usr_8f2…" } },
      { "start": 413, "end": 590, "author": { "system": "linear", "account": "usr_31a…" } }
    ]
  },
  "file:docs/pricing-policy.md": {
    "uri": "file:docs/pricing-policy.md",
    "resolver": "builtin:file",
    "version": "git:3f9c2e1",
    "text_sha256": "…",
    "attribution": [ "…one entry per run of lines by the same commit author…" ]
  }
}
```

The lockfile stores the snapshot text so that `check` can verify quotes offline. Each entry plays the role of a W3C Web Annotation `TimeState`: `retrieved_at` corresponds to `sourceDate`, and `text` to the `cached` copy. A later version may emit citations as Web Annotation documents so other tools can read them. When a source changes upstream, the change appears as a lockfile diff in a pull request and can be reviewed like a dependency bump.

## 8. Commands

| Command | Network | Purpose |
|---|---|---|
| `live-comments check` | none | Parse annotations and verify them against the lockfile. Deterministic; intended for every save and for CI. |
| `live-comments sync` | yes | Re-fetch every referenced source, update the lockfile, and report what changed. Run on demand, nightly, or on PRs. |
| `live-comments read <ref>` | yes | Resolve and normalize one source, record it in the lockfile, and print the text to quote from (§6.2). |
| `live-comments mcp` | yes | Run an MCP server whose `read_source` tool does the same as `read`, so coding agents read sources through the checker's path. |
| `live-comments report` | none | List open questions and their owners, plus coverage per governed area. |
| `live-comments rename` | none | Rename an opening id in the code and the owners file together (§6.7). |
| `live-comments identities suggest` | yes | Propose account-to-principal mappings for review (§6.6). |

### 8.1 Diagnostics

| Code | Severity | Raised by | Meaning |
|---|---|---|---|
| LC001 | error | check | Malformed annotation |
| LC002 | error | check | Quote not found in the locked snapshot |
| LC003 | error | check | Ref missing from the lockfile; run `sync` |
| LC004 | error | check | Export in a governed area has no `@source` or `@open` |
| LC006 | error | sync | Stale: the quote no longer appears in the current source |
| LC007 | error | sync | Source unreachable or access denied |
| LC008 | error | check | Quote falls inside text the resolver redacted |
| LC009 | error | check | Quoted words in a governed area were not written by a principal authorized for that code |
| LC010 | warn | check, sync | Quoted words were written by an account that maps to no principal |
| LC011 | error | check | `@open` id has no entry in the owners file |
| LC012 | warn | check | Owners file entry is not used by any `@open` |
| LC013 | error | check | Quoted span has no attributable author |
| LC100 | info | check, report | Open question, with its owner |


## 9. Packaging

- **CLI** built on the TypeScript compiler API. This is the authoritative checker.
- **ESLint rule** wrapping `check`, for existing CI pipelines.
- **Editor plugin** (later): hovers that show each quote and who wrote it, and a "cite from linked issue" quick fix. TypeScript language-service plugins affect only the editor and cannot fail `tsc`, so enforcement belongs in the CLI or lint, not in a compiler plugin.
- The annotation grammar (§4), resolver contract and normalization (§6) and lockfile format (§7) are meant to be language-neutral. TypeScript is the reference implementation.
- The reference implementation is built on Effect. The resolver contract is an Effect service, and each binding is a Layer: `file` and `nango` in production, fixtures in tests. Effect handles retries with backoff, timeouts, limits on concurrent requests and partial failure during `sync`, and its typed errors map onto LC007. Users of the CLI never see Effect.
- The first release ships the `file` and `nango` bindings, with extractors for GitHub, Linear, Notion, Jira and Google Docs.

## 10. Non-goals for v0

- Checking whether a quote semantically supports the code
- Recording approval or sign-off of decisions. Live Comments checks who wrote the words a rule rests on; endorsement belongs to governance tools such as Bicameral
- Sources that Nango cannot reach
- Languages other than TypeScript
- Detecting uncited logic beyond the governed-export rule
- Runtime behavior for open questions

## 11. Open design questions

1. **Noise.** Should citations live inline, or in a sidecar file keyed by symbol, with inline tags optional? Inline citations are visible where the code is read; a sidecar keeps the code clean.
2. **Citation laundering.** An agent pressured to satisfy LC004 can cite a nearby but irrelevant quote. Deterministic checks catch missing and misquoted citations, not irrelevant ones. What advisory signal is cheap enough to run on every PR?
3. **Runtime semantics of open questions.** When an `@open` rule must run, should it fail closed, run a default explicitly marked provisional, or run every reading and log where they disagree?
4. **Normalization edge cases.** Tables, code blocks, and quotes that span two comments in a thread or two blocks in a document.
5. **Agents that bypass the read path.** An agent can still read a ticket through another tool and paraphrase it. LC002 catches the mismatch but not the reason. Should `read` record which session read which source, so a report can show quotes that were never read through it?
6. **Edited text.** A ticket body edited by several people, or an agent editing text under a person's credentials. What should attribution report when the provider's history is incomplete?
7. **The authority format.** §6.6 and §6.7 are placeholders. They will be replaced by a single authority file whose format is the main design question of this project.

## 12. Related work

- **Requirements tracing tools** such as StrictDoc (`@relation` markers in source) and OpenFastTrace link code to requirements kept in a controlled document. They assume the requirements are already approved, and they do not verify quotes.
- **Spec-driven AI development** (Kiro, Spec Kit, Tessl) keeps specs next to code as the agent's input. The Spec Growth Engine (Grabowski, arXiv:2606.27045) adds a blocking merge gate on spec–code drift and treats code with no owning spec as an error. Specs there live in the repository and can be written in the same commit as the code they justify.
- **AsDecided** proposes that agents cite architectural decisions by id, revision and status in plans and pull requests, with a checker confirming each record exists and applies.
- **Standards.** OSLC (OASIS) defines linked-data integration between lifecycle tools and is used mainly by enterprise requirements-management tools. ReqIF exchanges requirements documents between tools as files. The Model Context Protocol is how Live Comments offers its read path to coding agents (§8). The W3C Web Annotation Data Model gives quote selectors and time states a standard shape, which Live Comments follows (§4.1, §7).

Live Comments differs in four places: citations are verbatim quotes checked against external sources; each quote is attributed to the person who wrote it; who may decide each area of code is declared in governed files and checked against that author; and uncited logic is reported as an open question with the people who can close it.

## 13. Milestone 0

Run the checker on one real codebase and report the share of exported functions in governed areas that cite no source. That number is the first result.
