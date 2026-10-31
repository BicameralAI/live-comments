#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import {
  authorityListing,
  check,
  composioTransport,
  CONFIG_FILE,
  context,
  type Diagnostic,
  directory,
  hasErrors,
  loadWorkspace,
  providers,
  read,
  renderSnapshot,
  report,
  SourcesLive,
  sync,
  TransportsLive,
  who
} from "@live-comments/core"
import { Effect, Either, Layer } from "effect"
import { CI_STEP, init } from "./init.js"
import { serveMcp } from "./mcp.js"

const USAGE = `live-comments — code comments that cite where a rule came from

Usage: live-comments <command> [options]

  init                          Scaffold config, AUTHORITY, the agent skill and MCP setup
  check [--base <rev>]          Verify annotations against the lockfile and AUTHORITY
  sync                          Re-read every cited source and membership; update the lockfile
  read <ref>                    Read one source through the checker's path and record it
  context <file>:<line>         Facts an agent needs before annotating a line (JSON)
  who <expression>              Expand an authority expression
  authority                     Every name in AUTHORITY, expanded (JSON)
  directory <system> [--scope <s>]  A connected system's accounts and places (JSON)
  report                        Open questions and coverage
  connect <system> [--via composio|nango] [--connection <id>] [--base-url <url>]
                                Systems: github, linear, notion, jira, gdocs, slack
  mcp                           Serve read_source, context, who, authority, directory over MCP

Options: --json for machine-readable output, --root <dir> (default: current directory)`

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = args[i + 1]
  args.splice(i, v !== undefined && !v.startsWith("--") ? 2 : 1)
  return v !== undefined && !v.startsWith("--") ? v : ""
}
const jsonOut = flag("json") !== undefined
const root = path.resolve(flag("root") || process.cwd())
const [command, ...rest] = args

const print = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2))

const color = (sev: Diagnostic["severity"], s: string) =>
  !process.stdout.isTTY ? s : sev === "error" ? `\x1b[31m${s}\x1b[0m` : sev === "warn" ? `\x1b[33m${s}\x1b[0m` : `\x1b[36m${s}\x1b[0m`

const printDiagnostics = (ds: ReadonlyArray<Diagnostic>) => {
  for (const d of ds) console.log(`${d.file}${d.line ? `:${d.line}` : ""}  ${color(d.severity, `${d.code} ${d.severity}`)}  ${d.message}`)
  const n = (s: Diagnostic["severity"]) => ds.filter((d) => d.severity === s).length
  console.log(`\n${n("error")} error(s), ${n("warn")} warning(s), ${n("info")} note(s)`)
}

/** Jira over OAuth: find the site's API base from the sites the connection can reach. */
const discoverBaseUrl = async (system: string, toolkit: string): Promise<string | undefined> => {
  if (system !== "jira") return undefined
  const res = await Effect.runPromise(
    Effect.either(
      composioTransport({ kind: "composio", toolkit }).request({
        method: "GET",
        baseUrl: "https://api.atlassian.com",
        path: "/oauth/token/accessible-resources"
      })
    )
  )
  if (Either.isLeft(res) || !Array.isArray(res.right.body)) return undefined
  const sites = res.right.body as Array<{ id?: string; url?: string }>
  if (sites.length !== 1 || !sites[0]?.id) {
    if (sites.length > 1) console.error(`this connection reaches several Jira sites:\n${sites.map((s) => `  https://api.atlassian.com/ex/jira/${s.id}  (${s.url})`).join("\n")}\nrerun with --base-url <one of them>`)
    return undefined
  }
  console.log(`found Jira site ${sites[0].url}`)
  return `https://api.atlassian.com/ex/jira/${sites[0].id}`
}

const sources = (ws: { config: Parameters<typeof SourcesLive>[0]; root: string }) => SourcesLive(ws.config, ws.root).pipe(Layer.provide(TransportsLive))

const main = async (): Promise<number> => {
  switch (command) {
    case "init": {
      for (const line of await init(root)) console.log(line)
      console.log(`\nAdd this step to CI:\n\n${CI_STEP}\n\nNext: ask your agent to finish setup (governed areas, connect, AUTHORITY), as the live-comments skill describes.`)
      return 0
    }
    case "check": {
      const base = flag("base")
      const ws = await Effect.runPromise(loadWorkspace(root))
      const r = await Effect.runPromise(check(ws, base || undefined))
      if (jsonOut) print({ diagnostics: r.diagnostics, annotations: r.annotations.map((a) => ({ decl: a.decl, index: a.index, kind: a.annotation.kind, status: a.status })) })
      else printDiagnostics(r.diagnostics)
      return hasErrors(r.diagnostics) ? 1 : 0
    }
    case "sync": {
      const ws = await Effect.runPromise(loadWorkspace(root))
      const r = await Effect.runPromise(sync(ws).pipe(Effect.provide(sources(ws))))
      if (jsonOut) {
        print(r)
        return r.failures.length > 0 ? 1 : 0
      }
      console.log(`synced ${Object.keys(r.lock.sources).length} source(s), ${Object.keys(r.lock.memberships).length} membership(s); ${r.updated.length} changed`)
      for (const u of r.updated) console.log(`  changed  ${u}`)
      for (const m of r.membershipChanges) console.log(`  members(${m.place})  +${m.added.join(", +") || "0"}  -${m.removed.join(", -") || "0"}`)
      const shown = [...r.failures, ...r.impact.sync, ...r.impact.appeared.filter((d) => d.severity !== "info" || d.code === "LC019")]
      if (shown.length > 0) {
        console.log("")
        printDiagnostics(shown)
      }
      if (r.impact.resolved.some((d) => d.severity === "error")) console.log(`resolved ${r.impact.resolved.filter((d) => d.severity === "error").length} error(s)`)
      return r.failures.length > 0 ? 1 : 0
    }
    case "read": {
      const ref = rest[0]
      if (!ref) return usage()
      const ws = await Effect.runPromise(loadWorkspace(root))
      const r = await Effect.runPromise(Effect.either(read(ws, ref)).pipe(Effect.provide(sources(ws))))
      if (Either.isLeft(r)) {
        console.error(`${r.left._tag}: ${r.left.message}`)
        return 1
      }
      print(jsonOut ? r.right : renderSnapshot(r.right))
      return 0
    }
    case "context": {
      const m = /^(.*):(\d+)$/.exec(rest[0] ?? "")
      if (!m) return usage()
      print(context(await Effect.runPromise(loadWorkspace(root)), m[1]!, Number(m[2])))
      return 0
    }
    case "who": {
      const r = who(await Effect.runPromise(loadWorkspace(root)), rest.join(" "))
      if (Either.isLeft(r)) {
        console.error(r.left)
        return 1
      }
      print(r.right)
      return 0
    }
    case "authority":
      print(authorityListing(await Effect.runPromise(loadWorkspace(root))))
      return 0
    case "directory": {
      const system = rest[0]
      if (!system) return usage()
      const scope = flag("scope")
      const ws = await Effect.runPromise(loadWorkspace(root))
      const r = await Effect.runPromise(Effect.either(directory(system, scope || undefined)).pipe(Effect.provide(sources(ws))))
      if (Either.isLeft(r)) {
        console.error(`${r.left._tag}: ${r.left.message}`)
        return 1
      }
      print(r.right)
      return 0
    }
    case "report": {
      const r = report(await Effect.runPromise(loadWorkspace(root)))
      if (jsonOut) print(r)
      else {
        console.log(`Open questions (${r.opens.length})`)
        for (const o of r.opens) console.log(`  ${o.decl}:${o.line}  [${o.status}]  "${o.question}"${o.answeredBy ? `  → ${o.answeredBy}` : ""}`)
        console.log(`\nCoverage`)
        for (const c of r.coverage) console.log(`  ${c.area}  ${c.annotated}/${c.exported} exported declarations annotated`)
      }
      return 0
    }
    case "connect": {
      const system = rest[0]
      const provider = system ? providers[system] : undefined
      if (!system || !provider) {
        console.error(`connect needs one of: ${Object.keys(providers).join(", ")}`)
        return 1
      }
      const via = flag("via") || "composio"
      let baseUrl = flag("base-url") || undefined
      if (!provider.baseUrl && !baseUrl && via !== "composio") {
        console.error(provider.baseUrlHint ?? `connect ${system} needs --base-url`)
        return 1
      }
      let entry: Record<string, unknown>
      if (via === "composio") {
        const r = spawnSync(process.env.COMPOSIO_CLI ?? "composio", ["link", provider.toolkit], { stdio: "inherit" })
        if (r.status !== 0) {
          console.error("composio link did not finish; install the Composio CLI and log in, then retry")
          return 1
        }
        entry = { provider: system, composio: {} }
        if (!provider.baseUrl && !baseUrl) {
          const found = await discoverBaseUrl(system, provider.toolkit)
          if (!found) {
            console.error(provider.baseUrlHint ?? `connect ${system} needs --base-url`)
            return 1
          }
          baseUrl = found
        }
      } else if (via === "nango") {
        const connection = flag("connection")
        if (!connection) {
          console.error("connect --via nango needs --connection <id> from your Nango dashboard, and NANGO_SECRET_KEY in the environment")
          return 1
        }
        entry = { provider: system, nango: { integration: system, connection } }
      } else {
        console.error("--via must be composio or nango")
        return 1
      }
      const file = path.join(root, CONFIG_FILE)
      const config = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as Record<string, unknown>
      if (baseUrl) entry.baseUrl = baseUrl
      config.resolvers = { ...(config.resolvers as object | undefined), [system]: entry }
      await writeFile(file, JSON.stringify(config, null, 2) + "\n")
      console.log(`connected ${system} through ${via}; updated ${CONFIG_FILE}`)
      return 0
    }
    case "mcp":
      await serveMcp(root)
      return -1
    default:
      return usage()
  }
}

const usage = () => {
  console.log(USAGE)
  return command === undefined || command === "help" || command === "--help" ? 0 : 2
}

main().then(
  (code) => {
    if (code >= 0) process.exitCode = code
  },
  (e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
)
