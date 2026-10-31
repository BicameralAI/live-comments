# Live Comments — draft specification

**Status:** draft v0.1 · 2026-10-30 · BicameralAI
**Scope of this draft:** TypeScript reference implementation, built on Effect. Sources plug in through a resolver contract (§6); external tools are reached through Nango or Composio.

---

## 1. Problem

Business rules in code rarely say where they came from. A function decides that discount codes don't stack, that refunds round half-up, that a trial lasts 14 days. The decision was made somewhere: a ticket, a contract clause, a meeting. Or it was never made, and whoever wrote the code (increasingly, an agent) settled it on the spot.

Tests can't tell these cases apart. A rule that nobody decided passes just as well as one that someone with authority decided. Comments don't help either, because a comment is a claim nobody checks. It goes stale silently.

## 2. Idea

A **live comment** is a code comment that cites where a rule came from, and that a checker keeps honest:

```ts
/**
 * @source linear:ENG-142 "Only the best single discount applies per order" by pricing-call
 */
export function applyDiscounts(codes: Code[]): Price { … }

/** @open "Do discount codes stack with gift cards?" by pricing-call */
export function applyGiftCard(card: GiftCard, total: Price): Price { … }
```

A citation needs only a ref. Each extra part adds a check: a quote makes the checker confirm the words are still in the source, and `by` makes it confirm they were written by someone the team has named for that kind of decision. Code that cites nothing is not treated as wrong. It is marked `@open`, a question waiting for the people who can answer it.

## 3. Principles

1. **Track authority; never grant it.** Annotations name whose words a rule rests on. The names come from a governed vocabulary, the authority file (§7), which code cannot change. The checker compares those names against who actually wrote the quoted words.
2. **A ref binds; a quote and `by` prove.** A ref alone records where a rule came from. A verbatim quote lets the checker confirm, without a model, that the words are there. `by` lets it confirm who wrote them. Each check runs only when its part is present.
3. **Deterministic first.** Every check is deterministic and reproducible. Whether a quote *supports* the code is a semantic judgment; when added, it is advisory and never turns a check green.
4. **Uncited is open, not illegal.** A rule with no source is surfaced as a question, not suppressed and not guessed.
5. **Offline check, online sync.** `check` never touches the network. External sources are snapshotted into a committed lockfile, and refreshing that lockfile is a separate, explicit step.
6. **One read path.** Whoever writes a citation, person or agent, reads the source through the same resolver and normalization the checker uses (§6.2). A quote is therefore always checked against exactly the text its author saw.
7. **The code is the record.** Who decides what is written where the rule is, not in a separate map of paths to owners. Changes to it show up in review like any other change (§7.4).
8. **The checker states facts; the agent judges.** The CLI only reads, verifies and reports. Anything that needs judgment, such as matching "leave it to the pricing team" to a name, drafting person definitions or choosing what to govern, is left to the agent and the user, guided by the skill (§10).

## 4. Annotations

Annotations are JSDoc tags. They attach to the declaration that immediately follows the comment block, using JSDoc's usual attachment rules. JSDoc is used instead of decorators because decorators only apply to classes and class members, while business rules mostly live in plain functions and constants.

### 4.1 `@source`

```
@source <ref> ["<quote>"] [by <authority>]
```

Only `<ref>` is required. A declaration may carry several `@source` tags.

- **`<ref>`** identifies a source (§6.1). On its own, the checker confirms the source resolves and reports when it has changed since it was last synced (LC014).
- **`"<quote>"`** must occur verbatim in the source's normalized text (§6.2), with the same normalization applied to the quote. Matching is case-sensitive. Ellipses and paraphrase are not supported. A quote corresponds to the `exact` field of a W3C Web Annotation `TextQuoteSelector`; a later version may accept `prefix` and `suffix` to tell repeated occurrences apart.
- **`by <authority>`** is an authority expression (§7.2). The checker confirms that the author of the quoted words satisfies it (§6.3). Without a quote, the source's creator is checked instead.

### 4.2 `@open`

```
@open [<id>] "<question>" [by <authority>] [in <place>] [options "<a>" | "<b>" …]
```

Only `"<question>"` is required. Everything else is optional, and the question itself is free-form.

- **`<id>`** names the question so tools and people can refer to it, for example `checkout.discount-stacking`.
- **`by <authority>`** says who should answer.
- **`in <place>`** says where the answer should be written. A place can be as broad as a system or as narrow as one thread, for example `in linear:ENG-142` (§7.2).
- **`options`** lists the readings under consideration, so the answer can be one line.

An `@open` passes the coverage check (§5) and is listed in every report until it is replaced by a `@source`.

**Answer candidates.** When `in` names a single source, such as `in linear:ENG-142`, `sync` reads it, and `check` reports each passage there written by someone who satisfies the opening's authority (LC019), quoting it. Whether a passage answers the question is a judgment, so the checker never flips an `@open` itself: a person, or an agent following the skill, replaces it with a `@source` citing that passage.

**Sticky arguments.** When `sticky` is `true` in the config (§5), the `@source` that replaces an `@open` must keep the opening's `by` and `in`, combined as `by <who> in <where>`. The `options` and `<id>` are dropped, because the question has been answered. Whoever answers the question, usually an agent following the skill, edits the comment. `check` compares against the base branch and reports an `@open` replaced by a `@source` that dropped its sticky arguments (LC015). When `sticky` is `false`, the replacing `@source` may carry any arguments or none.

*Future:* distinguish a **parked** question (no one may choose yet) from a **permission** (the source explicitly allows either reading, so the implementer may choose).

## 5. Configuration

`live-comments.config.json` holds project settings:

```json
{
  "governed": ["src/checkout/**", "src/billing/**"],
  "sticky": true,
  "authority": "AUTHORITY",
  "resolvers": {
    "file":   { "builtin": "file", "root": "." },
    "linear": { "provider": "linear", "nango":    { "integration": "linear", "connection": "acme-prod" } },
    "notion": { "provider": "notion", "composio": { "connectedAccount": "ca_7Hq…" } }
  }
}
```

- **`governed`** lists where annotations are required. Requiring them everywhere produces junk citations written only to silence the checker. In a governed area, every exported function, class and top-level constant must carry at least one `@source` or `@open` (LC004).
- **`sticky`** controls whether an `@open`'s `by` and `in` carry over to the `@source` that answers it (§4.2). Default: `true`.
- **`authority`** is the path to the authority file (§7).
- **`resolvers`** maps ref schemes to resolvers (§6).

## 6. Sources

Any system can be a source if a resolver can read it. The checker knows only the resolver contract.

### 6.1 Refs

A ref is a URI. Its scheme selects a resolver from `resolvers` in the config: `linear:ENG-142`, `notion:8f1c…`, `file:docs/pricing-policy.md`.

### 6.2 The resolver contract

A resolver answers one question: what does this ref say now, and who wrote it?

```
resolve(ref) → { uri, text, version, retrieved_at, container, creator, attribution }
             | { error: "not_found" | "denied" | "unreachable" }
```

- `text` is the source's full current text, normalized as below. A resolver must not summarize or excerpt it.
- `version` must change whenever `text` changes. A provider's etag, an `updated_at` timestamp or a commit hash all qualify. If the provider offers none, `version` is the SHA-256 of `text`.
- `container` names where the source lives in its own system: a Linear team, a Notion space, a GitHub repository, a Drive folder. Places in the authority file match against it (§7.2).
- `creator` is the account that created the source.
- `attribution` maps spans of the normalized `text` to the accounts that wrote them: `[{ start, end, author: { system, account } }]` (§6.3).
- A resolver that must redact content (for example, to strip personal data) reports `redacted: true`. A quote that falls inside redacted text cannot be verified and is reported as LC008.
- Resolution must be read-only. A resolver never writes to its source.

**Normalization.** Every resolver produces plain text the same way, and the same steps are applied to every quote:

1. Convert the provider's rich format to plain text: Markdown, Atlassian Document Format and Notion blocks lose their markup and keep their words. Link text is kept and link targets are dropped.
2. Apply Unicode NFC, and replace curly quotes and apostrophes with straight ones.
3. Collapse runs of whitespace to one space and trim the ends.

**Agents use the same path.** Principle 6 is enforced by giving authors no reason to read a source any other way. `live-comments read <ref>` and the `read_source` tool of `live-comments mcp` (§9) resolve a source, normalize it, record the snapshot in the lockfile, and return the normalized text. An agent configured with that tool quotes from the text the checker will verify. A quote copied from a different rendering, such as a web page or another MCP server, may not match and is reported as LC002.

### 6.3 Attribution

Authority attaches to the person whose words are quoted, not to whoever owns the ticket or document as a whole. A ticket's description may be the product manager's while a comment under it is an engineer's guess, and quoting each carries different weight.

When a `@source` has a quote, the checker finds it in the normalized text and reads the author of that span from `attribution`:

- **Comments and messages** are attributed to their authors.
- **Ticket and document bodies** are attributed to their creators, as the provider reports them.
- **Repository files** are attributed line by line to the commit author, as `git blame` reports it.

A quote that spans text by several authors is attributed to all of them, and each must satisfy `by`. A span with no author is reported as LC013. When a `@source` has `by` but no quote, the source's `creator` is checked.

### 6.4 Bindings

| Binding | How |
|---|---|
| `builtin: file` | Reads files in the repository at the current commit, attributed line by line with `git blame`. |
| `provider` | Reads an external tool in two steps: a **transport** makes authenticated requests to the tool's own API, and an **extractor** turns the raw responses into normalized text and attribution. |

**Extractors** are small, pure functions from a provider's raw API responses to segments of text with their authors, one per provider. Because they read the provider's own API format, they do not depend on the transport. `directory` (§9) uses the same transports to list a provider's accounts and places. v0 ships:

| Ref | Source | Authors | Places |
|---|---|---|---|
| `github:owner/repo#12` | Issue or pull request, with comments | Issue author; each comment's author | `github:owner`, `github:owner/repo` |
| `linear:ENG-142` | Issue, with comments | Creator; each comment's author | `linear:team/ENG` |
| `notion:<page id>` | Page blocks, nested, with comments | Each block's last editor; each comment's author | `notion:database/<id>`, `notion:page/<id>` |
| `jira:PAY-311` | Issue, with comments (resolver needs `baseUrl`) | Creator; each comment's author | `jira:project/PAY` |
| `gdocs:<document id>` | Document, all tabs, with comments and replies | Owner (from Drive), as `email:`; each comment's author | `gdocs:folder/<id>` |
| `slack:C0123/1793415412.122609` | A message and its thread | Each message's author | `slack:channel/C0123` |

Messages and comments that a provider marks as coming from a bot or app are flagged and never satisfy authority, including messages a person's integration posted on their behalf.

**Transports** handle what makes integrations expensive to build: OAuth flows, token refresh and per-provider authentication. A transport only has to send an authenticated HTTP request to the provider's API and return the raw response. v0 ships two:

| Transport | Mechanism | Deployment | License |
|---|---|---|---|
| `nango` | Nango proxy | Nango Cloud, or self-hosted (the free self-hosted option includes the Auth and Proxy features this needs) | Elastic License 2.0 (source-available, not open source) |
| `composio` | Composio `proxyExecute`, using a connected account | Composio's hosted platform | Proprietary platform; MIT SDK |

Each source chooses its transport in the config (§5), so a project can mix them. A source that names neither uses Composio through the logged-in `composio` CLI, which suits local use; CI should use the SDK with an API key, or Nango. Projects should know that a hosted transport routes source text, including tickets and contracts, through a third party. Composio only lets a connected account call its own provider's API domain, which matches how Live Comments uses it.

*Later versions:* a `command` binding (an executable speaking the contract as JSON over stdin and stdout) and an `mcp` binding, for sources neither transport covers.

## 7. Authority

### 7.1 The authority file

The authority file is a vocabulary of names. It defines people, places and authorities, and nothing else. It holds no rules about paths or code: which authority applies to a rule is written on the rule itself, with `by`.

```
# AUTHORITY

# People. Every account on one line belongs to one person.
jdoe          = github:jdoe | linear:usr_8f2 | email:jdoe@acme.com
mlee          = github:mlee | notion:7c1e…
agent claude  = github:acme-claude[bot] | linear:app_91c…

# Groups.
pricing       = jdoe | mlee
legal         = members(linear:team/LEGAL)

# Places.
pricing-desk  = linear:team/PRICING | notion:space/Pricing
contracts     = gdrive:folder/Contracts

# Authorities: who, and optionally where.
pricing-call  = pricing in pricing-desk
tax-call      = legal in contracts
launch-call   = pricing-call & tax-call
```

### 7.2 Expressions

```
definition := [agent] <name> = <expr>
expr       := <account> | <place> | <name> | members(<place>)
            | expr "|" expr        either
            | expr "&" expr        both
            | expr in expr         who, writing where
```

- **Accounts** are `system:account`. A line of accounts joined by `|` defines one person, as git's `.mailmap` does.
- **Places** are prefixes of a source's location: a system, a container (team, space, repository, folder), a document, or a thread. `linear:team/PRICING` contains `linear:ENG-142` when the resolver reports ENG-142's container as `team/PRICING`.
- **A bare place is a place.** `members(<place>)` means the people who belong to it, resolved through the place's own tool at sync time. Membership changes appear in the lockfile diff.
- **`a | b`** is satisfied by words from either.
- **`a & b`** is satisfied when the words a rule cites, across all of its `@source` tags with the same `by`, include words from someone in `a` and from someone in `b`. Joint decisions usually cite two sources; one person who belongs to both also satisfies it.
- **`who in where`** is satisfied by words that someone in `who` wrote in `where`.
- Inline, `by` and `in` accept the same expressions, so a one-off needs no new name: `by jdoe in linear:ENG-142`.

Names are case-sensitive and must be defined once (LC017). Definitions may refer to later names, but not in a cycle (LC017).

### 7.3 Governance and agents

- **The authority file is governed.** It confers authority, so changes to it should require review by its code owners under branch protection. Otherwise anyone could gain authority by adding their own account to a group. Code can name authorities but never define them.
- **Agents never hold authority.** Accounts defined with `agent` never satisfy any expression, including through `members(…)` and place-only authorities. Words an agent wrote under a person's credentials are excluded whenever the provider can tell them apart.
- **Unknown names and accounts.** A `by` that uses an undefined name is an error (LC011). Quoted words written by an account that no person definition includes satisfy no expression except a place-only one, and are reported (LC010).
- **Agents propose; people approve.** Matching a plain-language request ("leave this to the pricing team") to a name, and drafting person or place definitions, are judgments, so the CLI does not attempt them. An agent reads the authority file and `directory` output, proposes a match or a new definition to the user, and adds a definition only with the user's agreement. The change then goes through the file's normal review.
- **Directories can supply people.** A project with an identity provider that supports SCIM can generate the person definitions from it.

### 7.4 Authority changes in review

Because authority is written inline, an agent writing code chooses which named authority a rule cites. It cannot invent or widen one, but it can choose. Review is therefore where authority is checked:

- `check --base <branch>` lists every `by` and `in` that was added, removed or changed relative to the base branch (LC016), for example "`applyDiscounts`: `by pricing-call` → `by eng`". In CI this becomes a pull-request comment, so authority changes stand out even in a large diff.
- The shipped skill (§10) tells agents to reuse the authority that neighbouring code uses, never to change an existing `by` unless asked, and to leave `by` off when unsure.

Live Comments does not record approval or sign-off. It checks who wrote the words a rule rests on, not whether anyone later endorsed them.

## 8. Lockfile

`live-comments.lock.json` is committed. It holds one entry per distinct ref under `sources`, and the resolved accounts of every `members(…)` place under `memberships`:

```json
{
  "sources": {
  "linear:ENG-142": {
    "uri": "https://linear.app/acme/issue/ENG-142",
    "resolver": "nango:linear",
    "retrieved_at": "2026-10-30T14:02:11Z",
    "version": "updated_at=2026-10-03T09:12:40Z",
    "container": "team/PRICING",
    "creator": { "system": "linear", "account": "usr_8f2…" },
    "text_sha256": "…",
    "text": "…normalized snapshot…",
    "attribution": [
      { "start": 0,   "end": 412, "author": { "system": "linear", "account": "usr_8f2…" } },
      { "start": 413, "end": 590, "author": { "system": "linear", "account": "usr_31a…" } }
    ]
  }
  },
  "memberships": {
    "linear:team/LEGAL": { "retrieved_at": "2026-10-30T14:02:12Z", "accounts": ["linear:usr_31a…"] }
  }
}
```

The lockfile stores the snapshot text so that `check` can verify quotes offline. It also records the resolved membership of every `members(…)` expression. Each entry plays the role of a W3C Web Annotation `TimeState`: `retrieved_at` corresponds to `sourceDate`, and `text` to the `cached` copy. When a source or a membership changes upstream, the change appears as a lockfile diff in a pull request and can be reviewed like a dependency bump.

## 9. Commands

| Command | Network | Purpose |
|---|---|---|
| `live-comments init` | none | Scaffold a project: empty config and authority file, the skill, and agent MCP configuration (§10). |
| `live-comments check [--base <branch>]` | none | Verify annotations against the lockfile and the authority file. With `--base`, also report authority changes (§7.4). Deterministic; intended for every save and for CI. |
| `live-comments sync` | yes | Re-fetch every referenced source and `members(…)` expression, update the lockfile, and report what changed. |
| `live-comments read <ref>` | yes | Resolve and normalize one source, record it in the lockfile, and print the text to quote from (§6.2). |
| `live-comments mcp` | yes | Run an MCP server exposing `read`, `context`, `who`, `authority` and `directory` as tools, so coding agents use the checker's read path and facts. |
| `live-comments context <file:line>` | none | Print, as JSON, the facts an agent needs before annotating: whether the line is governed, the annotations nearby, the authorities they use, and `sticky`. |
| `live-comments who <expr>` | none | Expand an authority expression into the people and places that satisfy it. |
| `live-comments authority` | none | Print every name in the authority file, fully expanded, as JSON. |
| `live-comments directory <system>` | yes | List a connected system's accounts (id, display name, email) and places (id, name) as JSON, so person and place definitions can be written with exact ids. |
| `live-comments connect <system> [--via nango\|composio] [--base-url <url>]` | yes | Connect a tool through a transport, which asks the user to sign in, and add its resolver to the config. Jira needs `--base-url`. |
| `live-comments report` | none | List open questions with who should answer them, plus coverage per governed area. |

### 9.1 Diagnostics

| Code | Severity | Raised by | Meaning |
|---|---|---|---|
| LC001 | error | check | Malformed annotation |
| LC002 | error | check | Quote not found in the locked snapshot |
| LC003 | error | check | Ref missing from the lockfile; run `sync` or `read` |
| LC004 | error | check | Export in a governed area has no `@source` or `@open` |
| LC006 | error | sync | Stale: the quote no longer appears in the current source |
| LC007 | error | sync | Source unreachable or access denied |
| LC008 | error | check | Quote falls inside text the resolver redacted |
| LC009 | error | check | Quoted words (or, without a quote, the source's creator) do not satisfy `by` |
| LC010 | warn | check | Quoted words were written by an account no person definition includes |
| LC011 | error | check | `by` or `in` uses a name the authority file does not define |
| LC013 | error | check | Quoted span has no attributable author |
| LC014 | info | check, sync | Source cited without a quote has changed since it was cited |
| LC015 | error | check | `@source` replaced an `@open` but dropped its sticky arguments |
| LC016 | info | check | Authority changed relative to the base branch |
| LC017 | error | check | Authority file defines a name twice or contains a cycle |
| LC019 | info | check | Possible answer to an `@open`: a passage in its `in` source by someone who satisfies its authority |
| LC018 | error | check | Ref uses a scheme with no configured resolver; run `connect` |
| LC100 | info | check, report | Open question, with who should answer it |

## 10. Agent skill and setup

Live Comments ships an agent skill that tells coding agents when to annotate, how to read sources, and how to follow the conventions already in the codebase.

- **One generic skill.** The skill is a single `skills/live-comments/SKILL.md` in the Agent Skills format, using only standard frontmatter, so every agent that supports the format reads the same file. An `AGENTS.md` snippet carries the same essentials for agents that do not support skills yet.
- **Setup is one command.** `npx live-comments init`:
  1. detects which agents the project uses (`.claude/`, `.cursor/`, `.github/`, `AGENTS.md`);
  2. installs the skill into `.agents/skills/live-comments/` and each detected agent's skills folder, or appends the snippet to `AGENTS.md`;
  3. registers `live-comments mcp` in each detected agent's MCP configuration;
  4. writes an empty `live-comments.config.json` and `AUTHORITY`;
  5. prints a CI step that runs `live-comments check --base`.

  Filling in the config and authority file is judgment, so `init` leaves it to the agent: the skill walks the agent through choosing governed areas with the user, connecting tools with `connect`, and drafting person, group and place definitions from `directory` output and git history.
- **Agents can do the setup.** Telling an agent "set up live-comments from github.com/BicameralAI/live-comments" is enough: the README directs it to run `init`. Because `init` commits the skill and configuration into the project, every later session and every teammate's agent picks them up.

## 11. Packaging

- **CLI** built on the TypeScript compiler API. This is the authoritative checker.
- **ESLint rule** wrapping `check`, for existing CI pipelines.
- **Editor plugin** (later): hovers that show each quote, who wrote it and what `by` expands to, and a quick fix that fills an `@open` from a linked source. TypeScript language-service plugins affect only the editor and cannot fail `tsc`, so enforcement belongs in the CLI or lint, not in a compiler plugin.
- The annotation grammar (§4), resolver contract and normalization (§6), authority expressions (§7) and lockfile format (§8) are meant to be language-neutral. TypeScript is the reference implementation.
- The reference implementation is built on Effect. The resolver contract is an Effect service, and each binding is a Layer. Transports are a separate service with `nango` and `composio` Layers, so every extractor runs unchanged over either; tests provide recorded responses through a fixture transport. Effect handles retries with backoff, timeouts, limits on concurrent requests and partial failure during `sync`, and its typed errors map onto LC007. Users of the CLI never see Effect.
- The first release ships the `file` and `provider` bindings, the `nango` and `composio` transports, extractors for GitHub, Linear, Notion, Jira, Google Docs and Slack, and the skill.

## 12. Non-goals for v0

- Checking whether a quote semantically supports the code
- Recording approval or sign-off of decisions. Live Comments checks who wrote the words a rule rests on; endorsement belongs to governance tools such as Bicameral
- Mapping paths to owners. Authority is named on each rule (§7)
- Sources that neither Nango nor Composio can reach
- Languages other than TypeScript
- Detecting uncited logic beyond the governed-export rule
- Runtime behavior for open questions

## 13. Open design questions

1. **Noise.** Should citations live inline, or in a sidecar file keyed by symbol, with inline tags optional? Inline citations are visible where the code is read; a sidecar keeps the code clean.
2. **Citation laundering.** An agent pressured to satisfy LC004 can cite a nearby but irrelevant source. Deterministic checks catch missing and misquoted citations, not irrelevant ones. What advisory signal is cheap enough to run on every PR?
3. **Runtime semantics of open questions.** When an `@open` rule must run, should it fail closed, run a default explicitly marked provisional, or run every reading and log where they disagree?
4. **Normalization edge cases.** Tables, code blocks, and quotes that span two comments in a thread or two blocks in a document.
5. **Agents that bypass the read path.** An agent can still read a ticket through another tool and paraphrase it. LC002 catches the mismatch but not the reason. Should `read` record which session read which source, so a report can show quotes that were never read through it?
6. **Edited text.** A ticket body edited by several people, or an agent editing text under a person's credentials. What should attribution report when the provider's history is incomplete?
7. **Required parts.** Should a project be able to require quotes or `by` in some governed areas, instead of leaving both optional everywhere?

## 14. Related work

- **Requirements tracing tools** such as StrictDoc (`@relation` markers in source) and OpenFastTrace link code to requirements kept in a controlled document. They assume the requirements are already approved, and they do not verify quotes.
- **Spec-driven AI development** (Kiro, Spec Kit, Tessl) keeps specs next to code as the agent's input. The Spec Growth Engine (Grabowski, arXiv:2606.27045) adds a blocking merge gate on spec–code drift and treats code with no owning spec as an error. Specs there live in the repository and can be written in the same commit as the code they justify.
- **AsDecided** proposes that agents cite architectural decisions by id, revision and status in plans and pull requests, with a checker confirming each record exists and applies.
- **Standards.** OSLC (OASIS) defines linked-data integration between lifecycle tools and is used mainly by enterprise requirements-management tools. ReqIF exchanges requirements documents between tools as files. The Model Context Protocol is how Live Comments offers its read path to coding agents (§9). The W3C Web Annotation Data Model gives quote selectors and time states a standard shape, which Live Comments follows (§4.1, §8). Git's `.mailmap` is the model for person definitions (§7.2).

Live Comments differs in four places: citations are checked against external sources, optionally down to a verbatim quote; each quote is attributed to the person who wrote it; authority is named on each rule from a governed vocabulary and checked against that author; and uncited logic is an open question addressed to the people who can answer it.

## 15. Milestone 0

Run the checker on one real codebase and report the share of exported functions in governed areas that cite no source. That number is the first result.
