# Run the relay locally

Every command works the same in zsh, bash and PowerShell. Run them from `packages/server`.
Nothing here deploys or logs in to Cloudflare: `wrangler dev` runs the Worker, the Durable Objects and D1 on your machine.

## 1. Install (once, from the repo root)

```
bun install
```

## 2. Local config

Copy the example to `.dev.vars` (gitignored):

```
bun -e "require('node:fs').copyFileSync('.dev.vars.example', '.dev.vars')"
```

It defines four principals and two robots (`r1`, `r1-sim`):

| principal | role  | token                    |
| --------- | ----- | ------------------------ |
| `user-1`  | user  | `local-user-token-0000`  |
| `admin`   | admin | `local-admin-token-0000` |
| `r1-runtime` | runtime | `local-runtime-token-0000` |
| `r1-organs`  | organ   | `local-organ-token-0000`   |

`user` and `admin` call tools; only `runtime` connects as the robot (`/ws/robot`) and only `organ` attaches a provider (`/ws/organ`).

`PRINCIPALS` holds only SHA-256 hashes. To add a principal, make a token and its hash, then add an entry:

```
bun scripts/hash-token.ts
```

Timings (`HB_TIMEOUT_MS`, `STOP_VERIFY_MARGIN_MS`, ...) are in `wrangler.jsonc` under `vars`.

## 3. Local database

```
bun x wrangler d1 migrations apply spinecord --local
```

The data lives in `.wrangler/state` (gitignored). Delete that folder to start clean.

## 4. Start

```
bun x wrangler dev --port 8787
```

Check it:

```
curl http://localhost:8787/health
curl -H "Authorization: Bearer local-admin-token-0000" http://localhost:8787/api/robots
```

(In Windows PowerShell 5 use `curl.exe`.) A broken `PRINCIPALS` makes every route answer `503 misconfigured` with the reason.

## 5. Connect things

- **MCP client**: Streamable HTTP at `http://localhost:8787/mcp`, header `Authorization: Bearer local-user-token-0000`.
- **Runtime** (robot page or headless twin): WebSocket `ws://localhost:8787/ws/robot?robot_id=r1`, first frame `hello` with the runtime token (`local-runtime-token-0000`; a user or admin token is refused), `profile_hash` (`profileHash(profile)` from `packages/protocol/validate.ts`) and `stop_worst_ms` (CONTRACT.md §8). Without `?robot_id=` the worker reads it from `hello` and bridges the socket; with it the socket goes straight to the robot's Durable Object, which is the path to prefer.
- **Twin**: `apps/twin-runner` is that headless runtime. Put the runtime token (`local-runtime-token-0000`) in a file outside the repo, then from the repo root: `bun apps/twin-runner/main.ts --server ws://localhost:8787/ws/robot --token-file <file> --profile deployments/example/robots/r1.json --world packages/sim-world/examples/line-oval.json` runs `r1-sim` (add `--view` to watch it). `bun run e2e` does all of this by itself, with the relay in Miniflare.
- **Organ**: `ws://localhost:8787/ws/organ?robot_id=r1`, same rule.

## 6. See what happened

- Every call prints one JSON line in the `wrangler dev` terminal: `{"ev":"call","robot_id","tool","call_state","code","ms","trace_id","principal"}`. Also `link`, `activity`, `organ`, `stop`, `control`, `ws_refused`.
- The same calls are in D1: `curl -H "Authorization: Bearer local-admin-token-0000" "http://localhost:8787/api/calls?robot_id=r1&limit=20"`.
- SQL directly: `bun x wrangler d1 execute spinecord --local --command "SELECT tool, state, code, ms FROM calls ORDER BY created_at DESC LIMIT 20"`.

## 7. Tests

```
bun test
```

runs the tests with `bun test`: `test/setup.ts` (preloaded by `bunfig.toml`) bundles the Worker once and starts one Miniflare (workerd, Durable Objects, D1) for the whole process; the tests reach it over loopback HTTP, with a fake runtime over real WebSockets and the timings shortened in `test/setup.ts`. `RELAY_TEST_LOGS=1` prints the Worker's log lines. From the repo root, `bun check` typechecks every package (it runs `wrangler types` first) and `bun run ci` runs everything.
