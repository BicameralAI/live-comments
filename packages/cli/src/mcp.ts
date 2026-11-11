import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  authorityListing,
  context,
  directory,
  loadWorkspace,
  read,
  renderSnapshot,
  SourcesLive,
  TransportsLive,
  who
} from "@live-comments/core"
import { Effect, Either, Layer } from "effect"
import { z } from "zod"

// `live-comments mcp`: the checker's read path and facts as MCP tools, so coding
// agents read sources exactly the way the checker verifies them (spec §6.2).

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] })
const json = (v: unknown) => text(JSON.stringify(v, null, 2))
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true })

// Tool hints, so hosts know which calls they can make without asking. Only read_source
// writes, and only its ref's entry in the committed lockfile (spec §8), so it is not
// destructive. read_source and directory reach the network; the rest read the workspace.
const LOCAL_READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
const REMOTE_READ = { ...LOCAL_READ, openWorldHint: true } as const
const LOCK_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const

export const serveMcp = async (root: string) => {
  const server = new McpServer({ name: "live-comments", version: "0.0.1" })

  const withWs = <A>(f: (ws: Awaited<ReturnType<typeof load>>) => Promise<A>) => async () => f(await load())
  const load = () => Effect.runPromise(loadWorkspace(root))

  server.registerTool(
    "read_source",
    {
      description:
        "Read a source (ticket, document, file) through live-comments and record it in the lockfile. Copy quotes for @source tags exactly from this output.",
      inputSchema: { ref: z.string().describe("A ref such as github:owner/repo#12 or linear:ENG-142") },
      annotations: LOCK_WRITE
    },
    async ({ ref }) => {
      const ws = await load()
      const r = await Effect.runPromise(
        Effect.either(read(ws, ref)).pipe(Effect.provide(SourcesLive(ws.config, ws.root).pipe(Layer.provide(TransportsLive))))
      )
      return Either.isRight(r) ? text(renderSnapshot(r.right)) : fail(`${r.left._tag}: ${r.left.message}`)
    }
  )

  server.registerTool(
    "context",
    {
      description: "Facts to read before annotating a line: whether it is governed, nearby annotations and the authorities they use, and sticky.",
      inputSchema: { file: z.string(), line: z.number().int() },
      annotations: LOCAL_READ
    },
    async ({ file, line }) => json(context(await load(), file, line))
  )

  server.registerTool(
    "who",
    {
      description: "Expand an authority expression into the people and places that satisfy it.",
      inputSchema: { expression: z.string() },
      annotations: LOCAL_READ
    },
    async ({ expression }) => {
      const r = who(await load(), expression)
      return Either.isRight(r) ? json(r.right) : fail(r.left)
    }
  )

  server.registerTool(
    "authority",
    { description: "Every name in the AUTHORITY file, fully expanded.", inputSchema: {}, annotations: LOCAL_READ },
    withWs(async (ws) => json(authorityListing(ws)))
  )

  server.registerTool(
    "directory",
    {
      description: "List a connected system's accounts and places with exact ids, for writing AUTHORITY definitions.",
      inputSchema: { system: z.string(), scope: z.string().optional().describe("For GitHub, the organization") },
      annotations: REMOTE_READ
    },
    async ({ system, scope }) => {
      const ws = await load()
      const r = await Effect.runPromise(
        Effect.either(directory(system, scope)).pipe(Effect.provide(SourcesLive(ws.config, ws.root).pipe(Layer.provide(TransportsLive))))
      )
      return Either.isRight(r) ? json(r.right) : fail(`${r.left._tag}: ${r.left.message}`)
    }
  )

  await server.connect(new StdioServerTransport())
}
