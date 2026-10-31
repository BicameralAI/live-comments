## Live comments

This project marks where business rules come from with `@source` and `@open` JSDoc tags, checked by `live-comments`.

- Before writing a business rule, run `npx live-comments context <file>:<line>`.
- If a ticket, document or file decides the rule, add `@source <ref> ["<quote>"] [by <authority>]`. Read sources only with `npx live-comments read <ref>` and copy quotes exactly from its output.
- If nothing decides it, add `@open "<question>"`. Do not choose silently.
- Use only `by` names defined in `AUTHORITY`, reuse the ones nearby code uses, and never edit `AUTHORITY` or change an existing `by` unless asked.
- Run `npx live-comments check` before finishing, and list every `@open` you added in your summary.
