# Deploy the relay

One Cloudflare Worker with a Durable Object class (`RobotDO`, SQLite-backed) and a D1 database. Commands work in zsh, bash and PowerShell; run them from `packages/server`. You need a Cloudflare account and `bun x wrangler login` (or `CLOUDFLARE_API_TOKEN` with Workers Scripts:Edit and D1:Edit).

## 1. Create the database (once)

```
bun x wrangler d1 create spinecord
```

Put the printed `database_id` in `wrangler.jsonc` → `d1_databases[0].database_id` (it ships with a zero placeholder), then:

```
bun x wrangler d1 migrations apply spinecord --remote
```

## 2. Secret: `PRINCIPALS`

The only secret. JSON array, one entry per token holder; it stores hashes, never tokens:

```json
[
  { "principal_id": "team-1", "role": "user", "token_sha256": "<64 hex>", "robot_ids": ["r1", "r1-sim"] },
  { "principal_id": "ops", "role": "admin", "token_sha256": "<64 hex>", "robot_ids": ["*"] }
]
```

- `role: "user"` sees and operates the robots it lists (a twin is listed like any robot). `role: "admin"` may use `["*"]`, can call the admin tools (`take_control`, `release_control`, `stop_all`) and the HTTP API.
- A robot exists when some principal lists it by name. The principals that list it by name are its owners.
- Make each token and its hash with `bun scripts/hash-token.ts` (prints `{token, token_sha256}`). Hand the token to its holder over a private channel; only the hash goes in the secret.
- The principals of a real deployment belong in `deployments/<name>/`, without tokens.

Set it (paste the JSON on one line when prompted):

```
bun x wrangler secret put PRINCIPALS
```

Missing or malformed → every request answers `503 {"error":{"code":"misconfigured","message":"<what is wrong>"}}` until it is fixed. Tokens are never logged; logs name `principal_id` only.

## 3. Deploy

```
bun run ci
bun x wrangler deploy --var GIT_SHA:<commit sha>
```

## 4. Verify

```
curl https://<worker>.workers.dev/health
curl -H "Authorization: Bearer <admin token>" https://<worker>.workers.dev/api/robots
```

`/health` returns `{"ok":true,"version":"<sha>","robots":<n>}`. Then connect a runtime and call `list_robots` through MCP at `https://<worker>.workers.dev/mcp` (Streamable HTTP, `Authorization: Bearer <token>`).

## 5. Operate

- Logs: `bun x wrangler tail --format json`, or Workers Logs. One line per call: `{ev:"call", robot_id, tool, call_state, code, ms, trace_id, principal}`. An `internal` error's message carries the `trace_id` to search for.
- Call history: `GET /api/calls?robot_id=&since=&limit=` (admin). Episodes: `GET /api/episodes?robot_id=`. Programs: `GET /api/programs`, approve one in `needs_review` with `POST /api/programs/:name/:version/approve`.
- Emergency: `POST /api/stop-all`, `POST /api/robots/:id/stop`, `POST /api/robots/:id/control {"to":"admin"|"owner"}`.
- Rotate a token: replace that principal's `token_sha256` and run `wrangler secret put PRINCIPALS` again. The old token stops working at once.
- Timings (`vars` in `wrangler.jsonc`) follow CONTRACT.md: heartbeat 1 s, offline/stale at 3 s, organ gone at 30 s, a stop verified within the runtime's announced `stop_worst_ms` + 500 ms. Changing them changes the contract's guarantees.

## Limits to know

- Heartbeats need the Durable Object to wake every second while a robot is connected (one alarm per second per connected robot).
- Workers cap the size of one WebSocket message (check the current platform limit): keep camera frames (base64) small.
- `verify_program` holds one request open for all its trials (up to `trials × max_program_ms`).
