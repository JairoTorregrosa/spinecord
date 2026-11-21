# robot-body tooling

Generic tooling that lets a model (Claude) operate physical robots and their simulated twins through MCP. First hardware: LEGO EV3 on stock firmware over WebHID.

- Read `ARCHITECTURE.md` (package boundaries) and `CONTRACT.md` (behavior) before changing anything. Contract first, then `packages/protocol/*.ts`, then code.
- Nothing in `packages/` may reference a specific event, venue, team, task, place or map. Use-specific config lives in `deployments/<name>/` as data.
- The MCP surface is for models: English, precise descriptions, typed errors. Human-facing copy belongs to apps and deployments.
- Fail loud. Every command bounded. Every FSM transition asserted against `types.ts`.
- TypeScript, `bun test` per package. Before handing off: `bun run ci` (oxlint, oxfmt check, tsc, boundaries, tests, in parallel). Single steps: `bun lint`, `bun fmt`, `bun check`, `bun run test`.
- Everything runs on macOS and Windows (and Linux): scripts are TypeScript run with bun, never bash; package.json scripts use no shell syntax (no `&&` chains with env vars, no `rm -rf`, no globs the shell expands); paths via `node:path`; no hardcoded `/` or `\\`; files are LF (`.gitattributes`). Browser pieces target Chrome/Edge on both OSes (WebHID, Web Serial). CI runs on `macos-latest` and `windows-latest`.
