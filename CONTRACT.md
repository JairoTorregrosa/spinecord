# Contract v2 (2026-11-21): spinecord MCP

Audience: the model (Claude Fable 5.2) and the people who extend the robot. English only on the MCP surface.

Sources of truth, in this order: this file → `packages/protocol/types.ts` (types, FSM transition tables, wire protocol) → `packages/protocol/tools.ts` (tool names, descriptions, input schemas, server instructions, served verbatim).

## 0. Principles

1. **Generic primitives, no use cases.** A robot is a set of devices. A device self-describes its channels (what can be read) and commands (what it can do). The tool set is fixed; extending the robot means adding a device manifest, never a tool or a relay change.
2. **Bounded by construction.** Every command declares a bound (`degrees`, `ms` or `instant`) with a max. The relay rejects device manifests without one and checks the **shape** of args against the manifest (required fields, types, enums, unknown fields); sizes are the runtime's: it clamps args to the robot's limits, chunks what exceeds one operation, then validates what it will really send against the full schema. `command_device` and `drive` therefore clamp alike, on a direct call and inside a program. Clamping is reported, never hidden.
3. **Explicit state machines** (§1). Illegal transitions return `illegal_state` naming the current state.
4. **Every result carries robot state and `next`.** Errors are typed (§7), never disguised as data.
5. **Idempotent mutations.** `request_id` on every mutating tool; a retry returns the stored result.
6. **Fail loud.** Missing reply, stale image, unknown device → typed error.
7. **Fast loops live next to the hardware.** The runtime (§4) executes `until` conditions and programs locally; the relay only dispatches.
8. **Safety, honestly stated.** `stop` preempts everything. If the relay dies, the runtime stops the motors after 3 s without heartbeat. If the runtime dies, the guarantee depends on the driver: stock EV3 firmware has no watchdog, so every motion operation is limited by **time on the brick** (≤ 250 ms, time-based opcodes, never degree-based), and the robot overruns at most one chunk even against a blocked wheel. A provider whose device runs its own watchdog (ev3dev bridge: brakes after 1 s of silence) may declare a longer per-operation time bound; the runtime chunks to each command's declared bound, using short chunks only while an `until` condition must be checked; then it reads the condition while every operation runs and aborts the operation the moment it is met, and it also ends every operation itself at ≤ 250 ms of motion by aborting it, so neither a chunk in flight, a slow motor nor a long declared bound delays the reaction.
9. **Reads have no side effects.** A read never changes a device. Channels needing a sensor mode switch are read only when named explicitly while idle (§2.2).
10. **One owner per rule.** Motion limits: `profile.limits` only. Chunking: the runtime only. Program and condition validation: `packages/protocol/validate.ts` only. JSON Schema validation: `packages/protocol/schema.ts` only (`mode: "shape" | "full"`). Time limits of a call: the runtime only; the relay's deadline is a backstop behind them (§8). Profile identity: `profileHash()`.

## 1. State machines

Transition tables are exported from `types.ts` (`*_TRANSITIONS`). Implementations assert against them.

- **RobotLink** `offline → handshaking → online`; `online → offline` on 3 s without heartbeat or socket close (in-flight call → `failed robot_offline`); a new hello for the same robot replaces the old socket, and only a `runtime` credential bound to that robot is accepted as one (§10): a user or admin token is refused and replaces nothing.
- **RobotActivity** `idle | acting | stopping | running_program | fault`. Moving tools need `idle`; `stop {stop_id}` → `stopping` → `idle` when the runtime answers `stopped {stop_id, motors_stopped:true}` (verified = every motor reads speed 0), else `fault`. Fault triggers: stop unverified within the runtime's announced `stop_worst_ms` + 500 ms, 3 consecutive `stalled`, a battery device reporting `low` (threshold belongs to the driver config), runtime-reported error. Only `stop` and `reset_fault` act in `fault`. Read tools work in every online state.
- **Control** `owner ↔ admin`, both transitions stop the robot first.
- **Call** `received → rejected | deduplicated | queued → dispatched → completed | failed | timed_out | preempted`. One terminal state, logged once.
- **Episode** `none → running → ended → running`. Counts calls, moving calls, stops, errors, marks between start and end.
- **Provider/organ** `announced → active ↔ stale → gone` (stale at 3 s without heartbeat, gone at 30 s). Its devices disappear from `describe_robot` when gone.
- **Program** `draft → verified | needs_review → approved → retired`. `verified` = success_rate ≥ pass_rate on a twin, recorded with `verified_on {twin_id, profile_hash}`; a hardware robot runs it only when its `profile_hash` matches. The twin is built from the robot's profile (drivetrain geometry), never from simulator defaults. `needs_review` = uses a device kind the twin cannot simulate; an admin approves (HTTP API). On hardware only `verified`/`approved` run.

## 2. Device model

### 2.1 Shape

`DeviceSpec {id, provider, kind, roles[], channels[], commands[], description}` (types.ts). Ids are `<provider>.<local>`: `ev3.A`..`ev3.D` motors, `ev3.S1`..`ev3.S4` sensors, `ev3.pair` synced motor pair, `ev3.speaker`, `ev3.display`, `ev3.led`, `ev3.buttons`, `ev3.battery`; organs use their organ_id (`cam1.frame`, `mcu1.tof`). Tools accept a device id or a role.

### 2.2 Conventions

All angles and headings are counter-clockwise-positive seen from above, in every channel and command. Channels that share a `mode_group` need a sensor mode switch; only `active` ones are read by default, and a switch happens only when the caller names the channel and the robot is idle. Providers normalize hardware that reports otherwise (the EV3 gyro is clockwise-positive natively). Distances in cm, speeds in percent unless the unit says otherwise. Image channels return `Reading.image`, never a string in `value`.

### 2.3 Known kinds (open vocabulary; the runtime only depends on `motor_pair` for drivetrain tools)

| kind | channels | commands |
|---|---|---|
| motor | position_deg, speed_deg_s, stalled | run_degrees{degrees, speed_pct} · run_time{ms, speed_pct} · run_to_position{position_deg, speed_pct} · brake{} · reset_position{} |
| motor_pair | left_deg, right_deg | run_pair{left_deg, right_deg, speed_pct, brake?} (synchronized, both wheels finish together) · brake{} (instant; brakes only this pair — the runtime uses it to end a move after coasting chunks, never provider.stop()) |
| touch | pressed, presses | — |
| color | reflected_pct, ambient_pct, color (0 none,1 black,2 blue,3 green,4 yellow,5 red,6 white,7 brown), rgb (vector 3) | — |
| ultrasonic | distance_cm | — |
| gyro | angle_deg, rate_deg_s | reset{} |
| infrared | proximity_pct, beacon_heading, beacon_distance_pct, remote_buttons | — |
| speaker | last_spoken, spoken_count (twin only) | tone{frequency_hz, duration_ms} · beep{} · speak{text (≤ 200 chars), voice?, rate_wpm?} (optional, see below) |
| display | — | text{lines[]} · clear{} |
| led | — | set{pattern} |
| buttons | pressed (string[] of button names) | — |
| battery | voltage_v, low | — |
| camera | frame (image) | — |
| imu | accel (vector 3), gyro (vector 3), heading_deg | — |
| pose_tracker | pose (vector: x_cm, y_cm, heading_deg), frame (image) | — |
| servo | angle_deg | set_angle{angle_deg} |
| distance | distance_cm | — |
| sim_world | pose, frame (overhead image) | load_world{world} · reset{x_cm, y_cm, heading_deg} |

**Speech is a declared capability, not a tool.** A speaker lists `speak` only when its hardware can say a text (an ev3dev brick with `espeak` and `aplay`; stock EV3 firmware cannot). The model finds it with `describe_device`; a speaker without it answers `unknown_command`. `speak` has `moves: false` and bound `{kind: "ms", max}` where `max` is the longest a phrase may last (15000): it blocks until the speech has ended (`measured.spoken: true`), is cut at `max` (reason `timeout`), or is aborted — `stop` or aborting the call cuts the audio (reason `preempted`). `voice` is an enum of what the hardware offers, `rate_wpm` is words per minute. A command that does not move and declares an `ms` bound may block that long: the runtime and the relay wait for the bound instead of `max_command_ms` and the plain call timeout. The twin's `sim.speaker` makes no sound and returns at once: it records the text in `last_spoken` (and counts in `spoken_count`) so a test or a program's success condition can check what was said.

A new kind needs nothing but its manifest. Done-check: a microcontroller announcing `{kind:"gas", channels:[{name:"ppm"...}]}` is readable through `read_device` with zero code changes.

## 3. Robot profile

`RobotProfile {id, roles, drivetrain?, limits, notes}`. Without `drivetrain`, `drive/turn/arc` return `unsupported`. The default EV3 profile: educator base, pair B+C, wheel 5.6 cm, axle 12 cm. Notes are facts for the model, written by whoever built the robot.

## 4. Runtime

Owns chunking: it splits every motion into operations no longer than the command's declared time bound (short ~200 ms chunks only when an `until` must be evaluated), coasting between chunks with `brake:false` only when the measured round trip is small next to the chunk time (otherwise every chunk brakes) and braking on the last. Under `until` the runtime watches the condition for the whole move: it reads the condition's devices every max(10 ms, the round trip of one such read), also while an operation runs, and aborts the operation in flight the moment the condition is met, so the reaction time is one poll plus the abort's way to the device, not the rest of a chunk. A channel's `max_rate_hz` does not slow the watch down. After an operation that braked, the next one is sent only after a reading taken since; after one that coasts it is sent at once, watched. It also gives every operation a deadline of ≤ 250 ms from the moment it is sent and aborts the operation there (the abort travels the same link as the request, so the device has moved for that long when it lands): that abort is a chunk end, not a preemption, and the provider answers it like any abort (motion ended, `measured` so far). A remote organ is the exception: an abort does not travel through the relay, so its operations run to the bound its manifest declares, its condition is read between them, and an organ that moves under `until` must declare a short one.

Measuring a move costs no round trip of its own. The reading of the wheels (and the gyro) a move starts from is sent together with its first operation, and every later operation carries one too: **a provider serves calls in the order they were made**, so a reading made right before a command shows the device before that command starts. Progress is that reading plus the operation's own `measured`; what the device moves by itself between two operations (coasting on, creeping after a brake) shows in the next reading and is expected when the following operation is sized. One reading with nothing running closes the move, decides whether the target was reached, and is what `measured` reports. Those readings also time the link. Coasting needs a round trip timed just now: in the same call before anything moves, or at most 500 ms ago (moves sent back to back, as a program or a script does; that is how old the evidence gets between two chunks of one move). An older one is not evidence, the link may have changed: then, on a link last seen fast, the first reading is awaited. For a remote organ every reading is awaited. On a link last seen too slow to coast nothing is awaited, every operation brakes, and the readings show it when the link is fast again. Providers execute exactly one time-bounded operation per call. Runs where the hardware is: the robot's browser page (EV3 over WebHID), a headless bun process (twins, tests), or the local server's process (§11). It hosts providers (`Provider` in types.ts): the EV3 provider, the sim provider, and remote organ providers proxied through the relay. It implements every `RobotTool` (types.ts) with the semantics in `tools.ts`, executing `until` by watching the condition while ≤ 250 ms chunks run, and programs node by node. Errors are `RuntimeError{code}` from the §7 set.

Twin: `<id>-sim` is a runtime whose EV3 provider talks to a **simulated brick** (byte-level EV3 direct-command emulator backed by 2D physics), so the twin runs exactly the real EV3 code path. It adds the `sim.world`, `sim.camera` and `sim.speaker` devices.

## 5. Programs

JSON tree (`ProgramNode` in types.ts), no code. Caps: 500 nodes, `repeat.times ≤ 50`, `while.max_iterations ≤ 200`, `wait_ms ≤ 10000`, total ≤ `limits.max_program_ms`. The relay validates and stores (D1); `run_program` sends the body to the runtime, which executes it and returns per-step results. `verify_program` runs it `trials` times on a twin, calling `sim.world reset` between trials.

## 6. Episodes

Generic recording of an attempt. Counters come from the call log; marks are free-form kinds (`intervention`, `checkpoint`, …). No scoring logic in the server.

## 7. Envelope and error codes

`Envelope<T>` in types.ts. `isError: true` when `ok:false`. Every result (success and error) carries the envelope as `structuredContent`, and every tool advertises its `outputSchema` (`ToolDef.output` in tools.ts: the envelope with that tool's `data` shape; object root, open objects, minimal `required`, so one schema accepts both outcomes). For clients without structured output, one `text` block repeats it: line 1 is a one-line summary, the last line is the envelope as single-line JSON. Plus one `image` block when an image channel was read. Clients that write code against the tools: `docs/code-mode.md`.

| code | retryable | meaning |
|---|---|---|
| unauthorized | no | bad token or scope |
| unknown_robot / unknown_device / unknown_channel / unknown_command | no | name not found; message lists valid ones |
| unsupported | no | e.g. drive without drivetrain, sim.world on hardware |
| robot_offline | yes | runtime disconnected |
| busy | yes | activity is acting/running_program/stopping; `retry_after_ms` |
| not_in_control | no | an admin holds control |
| illegal_state | no | names current state and allowed tools |
| invalid_argument | no | names field, schema rule, allowed range |
| fault | no | use reset_fault after inspecting |
| timeout | yes · dispatched moving calls: no | the call outlived the relay's deadline (its own budget plus a margin, §8) and was aborted; robot state included. A tool's own time limit is never this error: it ends the call with data (`reason: "timeout"`, `met: false`, `outcome: "timeout"`). A move that timed out may have partly happened and was stopped: read the robot before moving again; the same `request_id` returns the same result |
| stop_unverified | no | robot is now in fault |
| provider_stale | yes | organ not heard from in 3 s |
| stale_image | yes | frame older than 1500 ms |
| program_not_runnable | no | not verified/approved for hardware, or retired |
| rate_limited | yes | > 5 mutating calls/s per robot |
| internal | no | trace_id in message |
| misconfigured | no | server config missing; every request fails until fixed |

## 8. Wire protocol

Types in `types.ts`: `RuntimeToRelay`/`RelayToRuntime` at `/ws/robot`, `OrganToRelay`/`RelayToOrgan` at `/ws/organ`. Heartbeat every 1 s both ways; the runtime's carries `echo {ts, held_ms}` of the relay's last one, from which the relay measures the round trip. `hello.token` is a credential of role `runtime` (`/ws/robot`) or `organ` (`/ws/organ`) bound to that robot; anything else is closed with code 4001 and a reason starting with `unauthorized:`. `call.deadline_ms` is a backstop, never the limit: the tool's own budget (`max_command_ms` for moves, `max_program_ms`, `timeout_ms`, `duration_ms`) plus `max(DEADLINE_MARGIN_MS, 2 × round trip) + stop_worst_ms`, so the runtime's limit ends the call first and answers with data; the relay itself gives up one more such margin later. Relay forwards `organ_req` from a runtime to the organ and the answer back as `organ_res`; it pushes `organs` to the runtime when the organ set changes. Organ frames are held in memory only and never stored.

## 9. HTTP API (admin, bearer)

Only an `admin` token; `/mcp` takes `user` and `admin` tokens. A `runtime` or `organ` credential gets `403 unauthorized` on both: it opens its socket and nothing else.

`GET /health` (no auth) · `GET /api/robots` · `POST /api/robots/:id/stop` · `POST /api/stop-all` · `POST /api/robots/:id/control {to}` · `GET /api/calls?robot_id&since&limit` · `GET /api/episodes?robot_id` · `GET /api/programs` · `POST /api/programs/:name/:version/approve`. All JSON, all queryable by an agent.

## 10. Storage

- **Durable Object per robot**: link, activity, control, episode, in-flight call, idempotency cache (10 min), organ registry.
- **D1**: `robots(id, owner_principal, backend, profile_json, devices_json, updated_at)` · `calls(id, robot_id, tool, request_id, state, code, ms, episode_id, created_at)` · `episodes(id, robot_id, label, tags_json, state, started_at, ended_at, outcome, metrics_json)` · `episode_marks(id, episode_id, kind, note, at)` · `programs(name, version, author, description, body_json, success_json, requires_json, pass_rate, state, success_rate, created_at, PK(name,version))` · `program_runs(id, name, version, robot_id, backend, outcome, ms, created_at)`.
- **Call log**: `calls` is written after the answer, never on its path. Each Durable Object batches its rows to D1 at most 50 ms after a call ends; a call the Worker answers alone (no robot) hands its row to the library's object. `/api/calls`, `/api/episodes` and episode summaries first wait for the rows of the robots they read, so a robot's answered calls are never missing from them; a row without a robot may trail its answer by a moment. A row that cannot be written is logged (`calls_write_error`) and never fails a call. An object that dies inside those 50 ms loses the rows it still held and nothing else: state and idempotency live in the object's own storage.
- **Config secret** `PRINCIPALS=[{principal_id, role: "user"|"admin"|"runtime"|"organ", token_sha256, robot_ids[]}]` (admins may use `robot_ids: ["*"]`). People and machines hold different credentials: `user`/`admin` call tools and never open a robot socket; `runtime` is the robot itself (`/ws/robot`) and `organ` an attached provider (`/ws/organ`), each bound to the robots it names (at least one, never `"*"`) and refused everywhere else. Whoever may operate a robot cannot impersonate it. Missing or malformed → every request 503 `misconfigured`. Tokens never logged. No personal data, no images stored.

## 11. Local mode

`apps/local` is spinecord on one computer: one bun process that serves MCP over stdio and holds the runtime (§4) and the providers of its robots. An MCP client starts it (`claude mcp add spinecord -- bun <repo>/apps/local/main.ts`); stdout carries JSON-RPC only, every log line is one JSON object on stderr. It opens no connection to a relay and stores nothing.

**Robots.** Chosen on the command line or in a config file (`bun apps/local/main.ts --help` lists every option):

| source | runtime's providers | link |
|---|---|---|
| `twin` | simulated brick + the real EV3 provider + `sim.world` (§4 Twin), world from a JSON file | online from start |
| `ev3dev` | ev3dev provider over the system `ssh` client | connected at start; the process does not start without it |
| `ev3` | the real EV3 provider over a byte transport: the bridge page in Chrome or Edge passes WebHID reports to one WebSocket on `127.0.0.1` | `offline` until the page has an EV3 open, `offline` again when the page, the cable or the brick goes |

The bridge page (`apps/robot-page/bridge.html`) runs no runtime and no timer on the path of a command: a browser fires the timers of a hidden or covered window once per second, and delivers socket messages and HID reports at once. The 10 ms `until` watch therefore runs in the process (measured: `apps/local/bench/results/hidden-page.json`). The server binds `127.0.0.1` by name, only when an `ev3` robot is configured, on a fixed port (default 8767; WebHID permission belongs to the origin); a taken port ends the process with a message. The socket accepts only the page the server serves, and one page: a second tab is closed with code 4009 and the reason "another tab already holds the robot", which that tab shows. The process tells the page it holds the robot (`{"t":"accepted"}`); when that socket closes, the page brakes every motor port by itself. A refused tab sends the brick nothing.

**Tools.** Local mode serves `list_robots`, `describe_robot`, `describe_device`, `read_device`, `read_all`, `sample_device`, `wait_until`, `drive`, `turn`, `arc`, `command_device`, `stop`, `reset_fault` and `run_program`: `LOCAL_TOOLS` in `tools.ts`, with `LOCAL_SERVER_INSTRUCTIONS`. Names, schemas and results are the catalog's, with these local definitions:

- `request_id` is optional and is a label: nothing is stored, a call sent twice acts twice.
- `run_program` takes the program inline (`body`, optional `success`, §5 caps) and the runtime interprets it.
- `list_robots` returns the robots of the process: `{id, backend, link, activity, fault_reason, connect}`; `connect` tells what a person must do to bring an offline robot online.
- The envelope (§7) is `LocalEnvelope`: `robot` is `{id, backend, link, activity}`. Every result validates against the tool's `outputSchema`; a result that does not is a JSON-RPC error, never sent as data.

**State.** Per robot, two machines, both asserted against the tables of §1:

- **Link** `offline → handshaking → online → offline`. `handshaking` = the first device scan plus a verified stop; a robot whose stop cannot be verified there comes online in `fault`.
- **Activity** `idle | acting | running_program | stopping | fault`.
  - One moving call at a time (`drive`, `turn`, `arc`, `run_program`, a `command_device` whose command has `moves: true`): it needs `idle` and takes `acting` or `running_program` before anything is awaited, so of two calls sent together one runs and the other answers `busy` with `retry_after_ms`. Nothing is queued.
  - `stop` is allowed in every state, never waits behind a call, and aborts every call in flight (a move ends with `reason: "preempted"`). `stopping → idle` when every motor reads speed 0 and the preempted call has ended, else `fault`. Stops sent together are one stop. A verified stop in `fault` stays in `fault`. One stop at a time reaches the hardware: a `stop` and a `reset_fault` sent together run one after the other, and `reset_fault` answers with the state the robot ends in (`stop_unverified` when either could not verify).
  - In `fault`, reads, `stop` and `reset_fault` work; `reset_fault` verifies the stop and goes to `idle`, or answers `stop_unverified`. Outside `fault` it answers `illegal_state`.
  - Reads and commands that do not move run in every state (commands: every state but `fault`).
- **Cancellation.** When the client cancels a call (`notifications/cancelled`), a moving call is stopped by the same verified `stop` and any other call is aborted; one `{"ev":"cancelled","robot_id","tool","action"}` line goes to stderr.
  - A moving call that fails after it started (the link dropped, the backstop passed) answers `retryable: false` with `next` starting at `read_all`: the robot may have moved, so the move is never to be sent again unread.
- A call's own limit is the runtime's (§0.10). Behind it the process keeps a backstop of that limit + 2 s + `stop_worst_ms`: past it the call is aborted, a moving one is stopped, and the answer is `timeout`.

**Errors (§7) that apply:** `unknown_robot`, `unknown_device`, `unknown_channel`, `unknown_command`, `unsupported`, `invalid_argument`, `robot_offline`, `busy`, `illegal_state`, `fault`, `stop_unverified`, `timeout`, `stale_image`, `internal`.

**Ending.** When stdin closes (the client went away) or the process receives SIGINT, SIGTERM or SIGHUP, every robot of the process first enters `closing` (life `serving → closing → closed`), in which every call answers `robot_offline` with `retryable: false` and a message that the server is shutting down; then it stops every online robot (verified, bounded by `stop_worst_ms`), writes one `{"ev":"stopped","robot_id","motors_stopped"}` line per robot on stderr, and exits. A process that is killed outright stops nothing itself: a stock EV3 is then braked by the bridge page, an ev3dev brick by its own watchdog (§0.8).
