# Live Comments — draft specification

**Status:** draft v0.1 · 2026-10-30 · BicameralAI
**Scope of this draft:** TypeScript reference implementation. Sources of any kind plug in through a resolver contract (§6).

---

## 1. Problem

Business rules in code rarely say where they came from. A function decides that discount codes don't stack, that refunds round half-up, that a trial lasts 14 days. The decision was made somewhere: a ticket, a contract clause, a meeting. Or it was never made, and whoever wrote the code (increasingly, an agent) settled it on the spot.

Tests can't tell these cases apart. A rule that nobody decided passes just as well as one that was signed off. Comments don't help either, because a comment is a claim nobody checks. It goes stale silently.

## 2. Idea

A **live comment** is a code comment that cites its source with a verbatim quote, and that a checker keeps honest:

```ts
/**
 * @source linear:ENG-142 "Only the best single discount applies per order"
 * @source file:decisions/0007-discounts.md "Discounts are not cumulative"
 */
export function applyDiscounts(codes: Code[]): Price { … }
```

The checker verifies that each quote still appears in its source, that the source has been ratified rather than merely proposed, and that business logic in governed areas cites something. Code that cites nothing is not treated as wrong. It is reported as an **open question** with an owner, until a person with standing closes it.

## 3. Principles

1. **Track authority; never grant it.** The annotations record that a rule needs a source and whether one exists. Nothing in the code can ratify a source. Ratification is an act that happens outside the program, in the system where the source lives. Standing to ratify belongs to the source's owner in that system (§6.7).
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
- A quote corresponds to the `exact` field of a W3C Web Annotation `TextQuoteSelector`. When a quote occurs more than once in a source, a later version may accept `prefix` and `suffix` to tell the occurrences apart, as that selector does.

### 4.2 `@open`

```
@open [<id>] "<question>"
```

Declares, deliberately, that a rule is not yet decided. An `@open` declaration passes the coverage check (§5) and is listed in every report until it is replaced by a `@source` that points at ratified material.

Code never names who may fill an opening. That is set in the governed owners file (§6.9), by path or by `<id>`. The optional `<id>` (for example `checkout.discount-stacking`) is needed only when one opening must have different owners from the rest of its path. The id is the only link between the comment and its owners entry. Tooling resolves the id to that entry's current line, so the link survives edits to either file.

*Future:* distinguish a **parked** question (no one may choose yet) from a **permission** (the source explicitly allows either reading, so the implementer may choose). v0 has only `@open`.

## 5. Governed areas

Not all code needs citations. Requiring them everywhere produces junk citations written only to silence the checker. Projects declare **governed areas** in `live-comments.config.json`:

```json
{
  "governed": ["src/checkout/**", "src/billing/**"],
  "unratified": "warn"
}
```

Sources are configured separately (§6.1). In a governed area, every exported function, class and top-level constant must carry at least one `@source` or `@open`.

## 6. Sources and ratification

Live Comments does not ship a fixed list of integrations. Any system can be a source if it implements the resolver contract below. The checker knows only the contract.

### 6.1 Refs

A ref is a URI. Its scheme selects a resolver configured in `live-comments.config.json`:

```json
{
  "resolvers": {
    "file":   { "builtin": "file", "root": "." },
    "linear": { "mcp": "linear", "template": "linear://issue/{id}" },
    "acme":   { "command": ["acme-resolver"] }
  },
  "status": {
    "file":   { "builtin": "git-approval", "path": "decisions/" },
    "linear": { "ledger": "https://ledger.example.com" }
  }
}
```

### 6.2 The resolver contract

A **text resolver** answers one question: what does this ref say now?

```
resolve(ref) → { uri, text, version, retrieved_at }
             | { error: "not_found" | "denied" | "unreachable" }
```

- `text` is the source's full current text, flattened to plain text. A resolver must not summarize or excerpt it.
- `version` must change whenever `text` changes. A provider's etag, an `updated_at` timestamp or a commit hash all qualify.
- A resolver that must redact content (for example, to strip personal data) reports `redacted: true`. A quote that falls inside redacted text cannot be verified and is reported as LC008.
- Resolution must be read-only. A resolver never writes to its source.

A **status provider** answers a separate question: has this ref been ratified, and by whom?

```
status(ref) → { status: "proposed" | "ratified" | "superseded",
                owners: [ { system, account } ],
                ratified_by?: { system, account, at },
                superseded_by? }
```

`owners` lists the accounts that own the source in its own system. Each status provider documents what "owner" means there: for example, a ticket's reporter or its project lead, a document's owner, or the parties to a contract. A project may override that choice per scheme in its config. `ratified_by` must be one of `owners`.

### 6.3 Text and status are separate

Any resolver can supply text. Only a status provider configured for that scheme can supply status, and a text resolver cannot claim ratification on its own behalf. A ref whose scheme has no status provider is `proposed`. This keeps the rule from §3: the system that serves a document is not, by serving it, the authority that ratified it.

### 6.4 Bindings

| Binding | Supplies | How |
|---|---|---|
| `builtin: file` | text | Reads files in the repository at the current commit. |
| `builtin: git-approval` | status | Reads frontmatter status and checks pull-request approval (§6.5). |
| `mcp` | text | Calls `resources/read` on a configured Model Context Protocol server, filling the URI template from the ref. Any MCP server that exposes its documents as resources becomes a source without new code. |
| `command` | text, status | Runs an executable that speaks the contract as JSON over stdin and stdout, for sources that have no MCP server. |
| `ledger` | text, status | Delegates to a governance ledger that records sign-offs, such as Bicameral. This is the binding that can return `ratified` for sources outside Git, such as tickets, documents and meeting notes. |

**Authentication.** Most of the work in an integration is authentication: OAuth flows, token refresh and per-provider quirks. The core does not handle it. A resolver may use an auth broker such as Nango, whose proxy returns raw provider API responses with managed credentials, or Composio, which exposes provider actions as agent tools and MCP servers. Either fits behind the `command` binding. A broker never supplies status, because it serves documents and does not record who ratified them (§6.3).

Before relying on a broker, a project should check two things. Hosted brokers route source text, including tickets and contracts, through a third party. Self-hosted options and their licenses differ by vendor and plan.

### 6.5 Ratified decision files

A decision file carries frontmatter:

```yaml
---
status: proposed | ratified | superseded
superseded_by: 0012-discounts-v2.md   # when superseded
---
```

A `ratified` status counts **only if** the commit that set it was merged through a pull request approved by a code owner of the decisions directory, under branch protection. The approval is the ratifying act. Because an agent cannot produce that approval, it cannot ratify its own sources. If the status was set any other way, the checker treats it as `proposed`.

### 6.6 Tickets, messages and documents

Without a ledger, text from trackers, chat and documents is `proposed`. A ticket records what someone asked for, not what was agreed. A project without a ledger can still rely on such a source by writing a decision file that quotes it and ratifying that file (§6.5).

### 6.7 Standing

Authority to settle a rule belongs to the external owner of the source that settles it. A ratified ticket carries its owner's authority. So does a signed contract or an approved decision file. Live Comments never decides who that owner is. It reads `owners` and `ratified_by` from the status provider and checks them against each other and against the owners file entry (§6.9) for the `@open` the source replaces.

Reports show, next to each `@open`, the principals that can fill it. If no owners entry matches, the report says that any ratified source can. When two cited sources conflict, or a source's owners cannot be mapped to principals (§6.8), "who decides" is reported as an open question in its own right instead of being guessed.

Standing is evaluated as of the version cited. If a source's owners change afterward, `sync` reports the change but does not revoke an earlier ratification.

### 6.8 Identity

The same person appears as different accounts in different systems: a GitHub login, a Linear user, a Slack member ID, an email address on a contract. Checking an opening's owners (§6.9) against a source's `owners` therefore needs a map from accounts to people.

`live-comments.identities.json` defines **principals**, each a person or a group, and the external accounts that belong to them:

```json
{
  "pricing-lead": { "accounts": [ { "system": "github", "account": "jdoe" },
                                  { "system": "linear", "account": "usr_8f2…" },
                                  { "system": "email",  "account": "jdoe@acme.com" } ] },
  "pricing":      { "members": ["pricing-lead", "finance-ops"] }
}
```

- **The identity file confers authority, so it is governed like the decisions directory.** A mapping counts only if it was merged through a pull request approved by the file's code owners. Otherwise anyone could gain standing by adding their own account to a principal.
- **Matching is assisted, not automatic.** `live-comments identities suggest` proposes mappings, for example from verified emails that several systems share. It writes proposals only, and a person approves them.
- **Unmapped accounts have no standing.** A source owned by an account that maps to no principal can still be cited. It cannot fill an `@open` that has an owners entry, and the report lists the account as unmapped (LC010).
- **Directories can replace the file.** A project with an identity provider that supports SCIM, or a ledger that already resolves identities, can configure it as the identity source. The file is the fallback for projects without one.

### 6.9 Owners of open questions

`live-comments.owners.json` says whose sources may fill an opening. It is governed like the identity file: an entry counts only if it was merged through a pull request approved by the file's code owners. An agent can therefore write `@open` freely but cannot choose who settles it.

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
- A `@source` that replaces an `@open` must come from a source owned by one of that entry's principals (LC009).

**Keeping code and owners file in sync.** Line numbers are never stored, because they drift with every edit. The id is the reference, and the line is computed:

- `check` reports an `@open` id with no `openings` entry (LC011) and an `openings` entry that no `@open` uses (LC012). Together these catch a rename made on one side only.
- `live-comments rename <old> <new>` renames an id in the code and in the owners file in one change.
- The editor plugin resolves an id to its entry's current line, for go-to-definition and for a hover showing the owners. `report` prints the same location (`live-comments.owners.json:9`), so links in CI output point at the right line.

## 7. Lockfile

`live-comments.lock.json` is committed. It holds one entry per distinct ref:

```json
{
  "linear:ENG-142": {
    "uri": "linear://issue/ENG-142",
    "resolver": "mcp:linear",
    "retrieved_at": "2026-10-30T14:02:11Z",
    "version": "updated_at=2026-10-03T09:12:40Z",
    "text_sha256": "…",
    "text": "…normalized snapshot…",
    "status": "proposed"
  },
  "file:decisions/0007-discounts.md": {
    "uri": "file:decisions/0007-discounts.md",
    "resolver": "builtin:file",
    "version": "git:3f9c2e1",
    "text_sha256": "…",
    "status": "ratified",
    "ratified_by": { "pr": 88, "approver": "…" }
  }
}
```

The lockfile stores the snapshot text so that `check` can verify quotes offline. Each entry plays the role of a W3C Web Annotation `TimeState`: `retrieved_at` corresponds to `sourceDate`, and `text` to the `cached` copy. A later version may emit citations as Web Annotation documents so other tools can read them. When a source changes upstream, the change appears as a lockfile diff in a pull request and can be reviewed like a dependency bump.

## 8. Commands

| Command | Network | Purpose |
|---|---|---|
| `live-comments check` | none | Parse annotations and verify them against the lockfile. Deterministic; intended for every save and for CI. |
| `live-comments sync` | yes | Re-fetch every referenced source, update the lockfile, and report what changed. Run on demand, nightly, or on PRs. |
| `live-comments report` | none | List open questions and their owners, plus coverage per governed area. |
| `live-comments rename` | none | Rename an opening id in the code and the owners file together (§6.9). |
| `live-comments identities suggest` | yes | Propose account-to-principal mappings for review (§6.8). |

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
| LC008 | error | check | Quote falls inside text the resolver redacted |
| LC009 | error | check | Source fills an `@open` but none of its owners belongs to that opening's principals |
| LC010 | warn | check, sync | Source owner's account maps to no principal |
| LC011 | error | check | `@open` id has no entry in the owners file |
| LC012 | warn | check | Owners file entry is not used by any `@open` |
| LC100 | info | check, report | Open question, with its owner |

\* LC005's severity is set by `unratified` in the config.

## 9. Packaging

- **CLI** built on the TypeScript compiler API. This is the authoritative checker.
- **ESLint rule** wrapping `check`, for existing CI pipelines.
- **Editor plugin** (later): hovers that show each quote and its status, and a "cite from linked issue" quick fix. TypeScript language-service plugins affect only the editor and cannot fail `tsc`, so enforcement belongs in the CLI or lint, not in a compiler plugin.
- The annotation grammar (§4), resolver contract (§6) and lockfile format (§7) are meant to be language-neutral. TypeScript is the reference implementation.
- The first release ships the `file`, `git-approval`, `mcp` and `command` bindings. Provider-specific resolvers live outside the core package.

## 10. Non-goals for v0

- Checking whether a quote semantically supports the code
- First-party resolvers for individual providers; sources arrive through MCP, commands or a ledger
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
- **Standards.** OSLC (OASIS) defines linked-data integration between lifecycle tools and is used mainly by enterprise requirements-management tools. ReqIF exchanges requirements documents between tools as files. The Model Context Protocol gives tools a common way to expose documents by URI, which Live Comments uses as a transport (§6.4). The W3C Web Annotation Data Model gives quote selectors and time states a standard shape, which Live Comments follows (§4.1, §7).

Live Comments differs in four places: citations are verbatim quotes checked against external sources; the cited source's ratification status is part of the check; ratification is an act the code author cannot perform; and uncited logic is reported as an open question with an owner.

## 13. Milestone 0

Run the checker on one real codebase and report the share of exported functions in governed areas that cite no source. That number is the first result.
