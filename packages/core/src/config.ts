import { Either, Schema } from "effect"

// live-comments.config.json (spec §5).

const NangoConfig = Schema.Struct({
  integration: Schema.String,
  connection: Schema.String,
  host: Schema.optional(Schema.String),
  secretEnv: Schema.optional(Schema.String)
})

const ComposioConfig = Schema.Struct({
  toolkit: Schema.optional(Schema.String),
  connectedAccount: Schema.optional(Schema.String),
  via: Schema.optional(Schema.Literal("cli", "sdk")),
  apiKeyEnv: Schema.optional(Schema.String)
})

const FileResolver = Schema.Struct({ builtin: Schema.Literal("file"), root: Schema.optional(Schema.String) })

const ProviderResolver = Schema.Struct({
  provider: Schema.String,
  nango: Schema.optional(NangoConfig),
  composio: Schema.optional(ComposioConfig)
})

export const ResolverConfig = Schema.Union(FileResolver, ProviderResolver)
export type ResolverConfig = typeof ResolverConfig.Type

export const Config = Schema.Struct({
  governed: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  sticky: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  authority: Schema.optionalWith(Schema.String, { default: () => "AUTHORITY" }),
  ignore: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  resolvers: Schema.optionalWith(Schema.Record({ key: Schema.String, value: ResolverConfig }), {
    default: () => ({ file: { builtin: "file" as const } })
  })
})
export type Config = typeof Config.Type

export const CONFIG_FILE = "live-comments.config.json"
export const LOCK_FILE = "live-comments.lock.json"

export const defaultConfig: Config = Schema.decodeUnknownSync(Config)({})

export const parseConfig = (json: string): Either.Either<Config, string> => {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (e) {
    return Either.left(`${CONFIG_FILE} is not valid JSON: ${String(e)}`)
  }
  return Schema.decodeUnknownEither(Config)(raw).pipe(Either.mapLeft((e) => `${CONFIG_FILE}: ${e.message}`))
}

// ---------------------------------------------------------------------------
// Globs: `**` crosses directories, `*` and `?` do not.

export const globToRegExp = (glob: string): RegExp => {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/"
        re += slash ? "(?:.*/)?" : ".*"
        i += slash ? 2 : 1
      } else re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`)
}

export const matchesAny = (globs: ReadonlyArray<string>, file: string): boolean =>
  globs.some((g) => globToRegExp(g).test(file))
