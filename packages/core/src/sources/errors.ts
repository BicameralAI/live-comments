import { Data } from "effect"

// Resolution errors (spec §6.2). Each maps onto a diagnostic: everything here
// becomes LC007 except UnknownScheme (LC018).

export class NotFound extends Data.TaggedError("NotFound")<{ readonly ref: string; readonly message: string }> {}
export class Denied extends Data.TaggedError("Denied")<{ readonly ref: string; readonly message: string }> {}
export class Unreachable extends Data.TaggedError("Unreachable")<{ readonly ref: string; readonly message: string }> {}
export class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly ref: string
  readonly message: string
  readonly retryAfterMs?: number
}> {}
export class ExtractionFailed extends Data.TaggedError("ExtractionFailed")<{ readonly ref: string; readonly message: string }> {}
/** The ref names a place (a team, a repository) rather than a document. */
export class NotADocument extends Data.TaggedError("NotADocument")<{ readonly ref: string; readonly message: string }> {}
export class UnknownScheme extends Data.TaggedError("UnknownScheme")<{ readonly ref: string; readonly message: string }> {}

export type ResolveError = NotFound | Denied | Unreachable | RateLimited | ExtractionFailed | NotADocument | UnknownScheme

export const describe = (e: ResolveError): string => `${e._tag}: ${e.message}`
