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

export const serveMcp = async (root: string) => {
  const server = new McpServer({ name: "live-comments", version: "0.0.1" })

  const withWs = <A>(f: (ws: Awaited<ReturnType<typeof load>>) => Promise<A>) => async () => f(await load())
  const load = () => Effect.runPromise(loadWorkspace(root))

  server.registerTool(
    "read_source",
    {
      description:
        "Read a source (ticket, document, file) through live-comments and record it in the lockfile. Copy quotes for @source tags exactly from this output.",
      inputSchema: { ref: z.string().describe("A ref such as github:owner/repo#12 or linear:ENG-142") }
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
      inputSchema: { file: z.string(), line: z.number().int() }
    },
    async ({ file, line }) => json(context(await load(), file, line))
  )

  server.registerTool(
    "who",
    { description: "Expand an authority expression into the people and places that satisfy it.", inputSchema: { expression: z.string() } },
    async ({ expression }) => {
      const r = who(await load(), expression)
      return Either.isRight(r) ? json(r.right) : fail(r.left)
    }
  )

  server.registerTool(
    "authority",
    { description: "Every name in the AUTHORITY file, fully expanded.", inputSchema: {} },
    withWs(async (ws) => json(authorityListing(ws)))
  )

  server.registerTool(
    "directory",
    {
      description: "List a connected system's accounts and places with exact ids, for writing AUTHORITY definitions.",
      inputSchema: { system: z.string(), scope: z.string().optional().describe("For GitHub, the organization") }
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
