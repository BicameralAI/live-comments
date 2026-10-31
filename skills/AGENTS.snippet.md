## Live comments

This project marks where business rules come from with `@source` and `@open` JSDoc tags, checked by `live-comments`.

- Before writing a business rule, run `npx live-comments context <file>:<line>`.
- If a ticket, document or file decides the rule, add `@source <ref> ["<quote>"] [by <authority>]`. Read sources only with `npx live-comments read <ref>` and copy quotes exactly from its output.
- If nothing decides it, add `@open "<question>"`. Do not choose silently.
- Use only `by` names defined in `AUTHORITY`. When the user says who decides, match their words against `npx live-comments authority`; if no name fits, propose a definition (with exact ids from `npx live-comments directory <system>`) and add it only after the user agrees. Otherwise reuse the names nearby code uses. Never change an existing `by` unless asked.
- If a source is in a tool the project can't read yet, ask the user to run `npx live-comments connect <system>`, and write an `@open` with `in <place>` meanwhile.
- Run `npx live-comments check` before finishing, and list every `@open` you added in your summary.
