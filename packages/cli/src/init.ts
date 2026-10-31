import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

// `live-comments init` (spec §10): scaffold only. Choosing governed areas and
// writing the authority file is judgment, left to the agent and the user.

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills")

const STARTER_CONFIG = {
  governed: [] as Array<string>,
  sticky: true,
  authority: "AUTHORITY",
  resolvers: { file: { builtin: "file" } }
}

const STARTER_AUTHORITY = `# AUTHORITY — names for people, places and authorities. See the live-comments spec, §7.
#
# People:       jdoe = github:jdoe | linear:usr_… | email:jdoe@acme.com
# Agents:       agent claude = github:acme-claude[bot]
# Groups:       pricing = jdoe | mlee        legal = members(linear:team/LEGAL)
# Places:       pricing-desk = linear:team/PRICING | notion:space/Pricing
# Authorities:  pricing-call = pricing in pricing-desk
`

const MCP_ENTRY = { command: "npx", args: ["-y", "live-comments", "mcp"] }

const writeIfAbsent = async (file: string, content: string, log: Array<string>) => {
  if (existsSync(file)) return log.push(`kept     ${file}`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
  log.push(`created  ${file}`)
}

const mergeJson = async (file: string, update: (o: Record<string, unknown>) => void, log: Array<string>) => {
  let o: Record<string, unknown> = {}
  if (existsSync(file)) {
    try {
      o = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    } catch {
      return log.push(`skipped  ${file} (not valid JSON)`)
    }
  }
  update(o)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(o, null, 2) + "\n")
  log.push(`updated  ${file}`)
}

export const init = async (root: string): Promise<ReadonlyArray<string>> => {
  const log: Array<string> = []
  const rel = (p: string) => path.relative(root, p) || "."
  const at = (...p: Array<string>) => path.join(root, ...p)

  await writeIfAbsent(at("live-comments.config.json"), JSON.stringify(STARTER_CONFIG, null, 2) + "\n", log)
  await writeIfAbsent(at("AUTHORITY"), STARTER_AUTHORITY, log)

  // The skill: the generic location, plus each agent the project already uses.
  const skill = await readFile(path.join(skillsDir, "live-comments", "SKILL.md"), "utf8")
  const skillTargets = [at(".agents", "skills")]
  if (existsSync(at(".claude"))) skillTargets.push(at(".claude", "skills"))
  if (existsSync(at(".cursor"))) skillTargets.push(at(".cursor", "skills"))
  if (existsSync(at(".github"))) skillTargets.push(at(".github", "skills"))
  for (const dir of skillTargets) {
    const file = path.join(dir, "live-comments", "SKILL.md")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, skill)
    log.push(`installed ${rel(file)}`)
  }

  // Agents without skill support read AGENTS.md.
  if (existsSync(at("AGENTS.md"))) {
    const agents = await readFile(at("AGENTS.md"), "utf8")
    if (!agents.includes("## Live comments")) {
      const snippet = await readFile(path.join(skillsDir, "AGENTS.snippet.md"), "utf8")
      await writeFile(at("AGENTS.md"), agents.replace(/\n*$/, "\n\n") + snippet)
      log.push("appended AGENTS.md")
    }
  }

  // MCP: Claude Code reads .mcp.json; Cursor .cursor/mcp.json; VS Code .vscode/mcp.json.
  await mergeJson(at(".mcp.json"), (o) => {
    o.mcpServers = { ...(o.mcpServers as object | undefined), "live-comments": MCP_ENTRY }
  }, log)
  if (existsSync(at(".cursor"))) {
    await mergeJson(at(".cursor", "mcp.json"), (o) => {
      o.mcpServers = { ...(o.mcpServers as object | undefined), "live-comments": MCP_ENTRY }
    }, log)
  }
  if (existsSync(at(".vscode"))) {
    await mergeJson(at(".vscode", "mcp.json"), (o) => {
      o.servers = { ...(o.servers as object | undefined), "live-comments": { type: "stdio", ...MCP_ENTRY } }
    }, log)
  }

  return log.map((l) => l.replace(root + path.sep, ""))
}

export const CI_STEP = `- name: Check live comments
  run: npx live-comments check --base origin/\${{ github.base_ref || 'main' }}`
