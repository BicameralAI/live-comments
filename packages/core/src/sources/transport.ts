import { execFile } from "node:child_process"
import { Context, Effect, Layer } from "effect"

// Transports (spec §6.4): send one authenticated request to a provider's own
// API and return the raw response. Extractors never see which transport ran.

export interface HttpRequest {
  readonly method: "GET" | "POST"
  /** Provider API base, e.g. https://api.github.com */
  readonly baseUrl: string
  /** Path relative to the base, e.g. /repos/acme/shop/issues/1 */
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
  /**
   * Set when the request goes to a host other than the integration's default,
   * e.g. the Drive API for a Google Docs source. Composio then uses `toolkit`'s
   * connection; Nango sends `Base-Url-Override`.
   */
  readonly hostOverride?: boolean
  readonly toolkit?: string
}

export interface HttpResponse {
  /** HTTP status, or undefined when the transport cannot report it. */
  readonly status: number | undefined
  readonly body: unknown
}

export class TransportFailure extends Error {
  constructor(message: string, readonly kind: "denied" | "unreachable" = "unreachable") {
    super(message)
  }
}

export interface Transport {
  readonly name: string
  readonly request: (req: HttpRequest) => Effect.Effect<HttpResponse, TransportFailure>
}

export type TransportConfig =
  | { readonly kind: "nango"; readonly integration: string; readonly connection: string; readonly host?: string; readonly secretEnv?: string }
  | { readonly kind: "composio"; readonly toolkit: string; readonly connectedAccount?: string; readonly via?: "cli" | "sdk"; readonly apiKeyEnv?: string }

/** Builds a transport for a source's configuration. Tests replace it with fixtures. */
export class Transports extends Context.Tag("live-comments/Transports")<
  Transports,
  { readonly get: (config: TransportConfig) => Transport }
>() {}

const url = (req: HttpRequest): string => {
  const qs = req.query && Object.keys(req.query).length > 0 ? "?" + new URLSearchParams(req.query).toString() : ""
  return req.baseUrl.replace(/\/$/, "") + req.path + qs
}

// ---------------------------------------------------------------------------
// Nango proxy

export const nangoTransport = (c: Extract<TransportConfig, { kind: "nango" }>): Transport => ({
  name: "nango",
  request: (req) =>
    Effect.tryPromise({
      try: async () => {
        const secret = process.env[c.secretEnv ?? "NANGO_SECRET_KEY"]
        if (!secret) throw new TransportFailure(`set ${c.secretEnv ?? "NANGO_SECRET_KEY"} to use the nango transport`, "denied")
        const qs = req.query && Object.keys(req.query).length > 0 ? "?" + new URLSearchParams(req.query).toString() : ""
        const res = await fetch(`${(c.host ?? "https://api.nango.dev").replace(/\/$/, "")}/proxy${req.path}${qs}`, {
          method: req.method,
          headers: {
            ...req.headers,
            Authorization: `Bearer ${secret}`,
            "Provider-Config-Key": c.integration,
            "Connection-Id": c.connection,
            ...(req.hostOverride ? { "Base-Url-Override": req.baseUrl } : {}),
            ...(req.body !== undefined ? { "Content-Type": "application/json" } : {})
          },
          ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {})
        })
        const text = await res.text()
        return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null }
      },
      catch: (e) => (e instanceof TransportFailure ? e : new TransportFailure(`nango: ${String(e)}`))
    })
})

// ---------------------------------------------------------------------------
// Composio: proxyExecute through the SDK, or `composio proxy` through the CLI

/** Run a command with stdin closed; the child is killed on timeout or interruption. */
const run = (cmd: string, args: ReadonlyArray<string>, signal: AbortSignal) =>
  new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const child = execFile(cmd, args as Array<string>, { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, signal }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === "number" ? Number((err as NodeJS.ErrnoException).code) : err ? 1 : 0
      resolve({ stdout, stderr: err && !stderr ? String(err.message) : stderr, code })
    })
    child.stdin?.end()
  })

export const composioCliTransport = (c: Extract<TransportConfig, { kind: "composio" }>): Transport => ({
  name: "composio",
  request: (req) =>
    Effect.tryPromise({
      try: async (signal) => {
        const args = ["proxy", url(req), "--toolkit", req.toolkit ?? c.toolkit, "-X", req.method]
        for (const [k, v] of Object.entries(req.headers ?? {})) args.push("-H", `${k}: ${v}`)
        if (req.body !== undefined) args.push("-H", "content-type: application/json", "-d", JSON.stringify(req.body))
        const { stdout, stderr, code } = await run(process.env.COMPOSIO_CLI ?? "composio", args, signal)
        const starts = [stdout.indexOf("{"), stdout.indexOf("[")].filter((i) => i >= 0)
        const jsonStart = starts.length > 0 ? Math.min(...starts) : 0
        let body: unknown
        try {
          body = JSON.parse(stdout.slice(jsonStart))
        } catch {
          throw new TransportFailure(`composio proxy returned no JSON (exit ${code}): ${(stderr || stdout).slice(0, 300)}`)
        }
        if (body && typeof body === "object" && (body as { successful?: unknown }).successful === false) {
          const b = body as { error?: string; slug?: string }
          const denied = /NoActiveConnection|Unauthorized|Forbidden|Expired/i.test(b.slug ?? "")
          throw new TransportFailure(`composio: ${b.error ?? b.slug ?? "request failed"}`, denied ? "denied" : "unreachable")
        }
        // The CLI prints the provider's response body but not its status.
        return { status: undefined, body }
      },
      catch: (e) => (e instanceof TransportFailure ? e : new TransportFailure(`composio: ${String(e)}`))
    })
})

export const composioSdkTransport = (c: Extract<TransportConfig, { kind: "composio" }>): Transport => ({
  name: "composio",
  request: (req) =>
    Effect.tryPromise({
      try: async () => {
        const apiKey = process.env[c.apiKeyEnv ?? "COMPOSIO_API_KEY"]
        if (!apiKey) throw new TransportFailure(`set ${c.apiKeyEnv ?? "COMPOSIO_API_KEY"} to use the composio SDK transport`, "denied")
        const mod = (await import("@composio/core" as string)) as {
          Composio: new (o: { apiKey: string }) => {
            tools: { proxyExecute: (p: Record<string, unknown>) => Promise<{ status?: number; data?: unknown }> }
          }
        }
        const client = new mod.Composio({ apiKey })
        const sameToolkit = req.toolkit === undefined || req.toolkit === c.toolkit
        const res = await client.tools.proxyExecute({
          endpoint: url(req),
          method: req.method,
          ...(c.connectedAccount && sameToolkit ? { connectedAccountId: c.connectedAccount } : {}),
          ...(req.body !== undefined ? { body: req.body } : {}),
          ...(req.headers ? { parameters: Object.entries(req.headers).map(([name, value]) => ({ in: "header", name, value })) } : {})
        })
        return { status: res.status, body: res.data }
      },
      catch: (e) => (e instanceof TransportFailure ? e : new TransportFailure(`composio: ${String(e)}`))
    })
})

/** Composio uses the SDK when an API key is available, otherwise the logged-in CLI. */
export const composioTransport = (c: Extract<TransportConfig, { kind: "composio" }>): Transport => {
  const via = c.via ?? (process.env[c.apiKeyEnv ?? "COMPOSIO_API_KEY"] ? "sdk" : "cli")
  return via === "sdk" ? composioSdkTransport(c) : composioCliTransport(c)
}

export const TransportsLive = Layer.succeed(Transports, {
  get: (c) => (c.kind === "nango" ? nangoTransport(c) : composioTransport(c))
})

// ---------------------------------------------------------------------------
// Fixtures, for tests: answer requests from a function of the full URL.

export const fixtureTransports = (
  handler: (url: string, req: HttpRequest) => HttpResponse | undefined
): Layer.Layer<Transports> =>
  Layer.succeed(Transports, {
    get: () => ({
      name: "fixture",
      request: (req) => {
        const res = handler(url(req), req)
        return res ? Effect.succeed(res) : Effect.succeed({ status: 404, body: { message: "Not Found" } })
      }
    })
  })
