# Contract v2 (2026-11-21): spinecord MCP

Audience: the model (Claude Fable 5.2) and the people who extend the robot. English only on the MCP surface.

Sources of truth, in this order: this file → `packages/protocol/types.ts` (types, FSM transition tables) → `packages/protocol/tools.ts` (tool names, descriptions, input and output schemas, server instructions, served verbatim).

spinecord runs on one computer: one bun process (`apps/local`) that serves MCP over stdio and holds the runtime (§4) and the providers of its robots. An MCP client starts it. It stores nothing.

## 0. Principles

1. **Generic primitives, no use cases.** A robot is a set of devices. A device self-describes its channels (what can be read) and commands (what it can do). The tool set is fixed; extending the robot means adding a device manifest, never a tool.
2. **Bounded by construction.** Every command declares a bound (`degrees`, `ms` or `instant`) with a max. The server checks a call's arguments against the tool's input schema; the runtime clamps args to the robot's limits, chunks what exceeds one operation, then validates what it will really send against the command's full schema. `command_device` and `drive` therefore clamp alike, on a direct call and inside a program. Clamping is reported, never hidden.
3. **Explicit state machines** (§1). Illegal transitions return `illegal_state` naming the current state.
4. **Every result carries robot state and `next`.** Errors are typed (§7), never disguised as data.
5. **Nothing is stored between calls.** `request_id` is an optional label. A moving call sent twice moves twice: after a failed or unanswered moving call, read the robot (`read_all`) before moving again.
6. **Fail loud.** Missing reply, stale image, unknown device → typed error. A robot that cannot be configured ends the process at start with a message.
7. **Fast loops live next to the hardware.** The runtime (§4) executes `until` conditions and programs in the process that holds the providers: no model turn per check.
8. **Safety, honestly stated.** `stop` preempts everything. When the client goes away or the process is signalled, the process stops every robot before it exits (§6). If the process dies outright, the guarantee depends on the driver: stock EV3 firmware has no watchdog, so every motion operation is limited by **time on the brick** (≤ 250 ms, time-based opcodes, never degree-based), the robot overruns at most one chunk even against a blocked wheel, and the bridge page brakes every motor when its socket closes. An ev3dev brick's motors are run by its kernel, which ends a timed run by itself but has no time limit for a move to a position: there the limits are the bridge's (it brakes at the operation's time bound, and after 1 s of silence from the computer) and, when the bridge process itself is killed, a guard process on the brick that brakes every motor as soon as the bridge is gone. A bridge that hangs without ending, or a brick whose kernel fails, is covered by nothing. A provider whose device has such a watchdog may declare a longer per-operation time bound; the runtime chunks to each command's declared bound, using short chunks only while an `until` condition must be checked; then it reads the condition while every operation runs and aborts the operation the moment it is met, and it also ends every operation itself at ≤ 250 ms of motion by aborting it, so neither a chunk in flight, a slow motor nor a long declared bound delays the reaction.
9. **Reads have no side effects.** A read never changes a device. Channels needing a sensor mode switch are read only when named explicitly while idle (§2.2).
10. **One owner per rule.** Motion limits: `profile.limits` only. Chunking: the runtime only. Program and condition validation: `packages/protocol/validate.ts` only. JSON Schema validation: `packages/protocol/schema.ts` only. Time limits of a call: the runtime only; the process's backstop stands behind them (§1). Link and activity of a robot: `apps/local` only.

## 1. State machines

Per robot, two machines. Their transition tables are exported from `types.ts` (`LINK_TRANSITIONS`, `ACTIVITY_TRANSITIONS`); `apps/local` owns both and asserts every transition against them.

- **Link** `offline → handshaking → online → offline`. `handshaking` = the first device scan plus a verified stop; a robot whose stop cannot be verified there comes online in `fault`, and a verified stop there clears an earlier `fault`: a robot that was in `fault` when its link closed is `idle` once a new link has attached, without `reset_fault`. `online → offline` when the robot's link closes: for an `ev3` robot the bridge page, the cable or the brick goes; for an `ev3dev` robot the ssh process ends (the brick, the network or the bridge went away, or the bridge was silent too long). A call in flight then ends with the driver's error, and `list_robots` shows `offline` with `connect`. A twin stays `online`. An `ev3dev` robot comes back by itself: the process opens a new ssh link, and when an attempt fails it starts the next one 2 s after that attempt ended. One attempt takes as long as ssh and the bridge's hello need, at most 20 s. A link the process closed stays closed: a call still in flight on it answers `robot_offline` at once and opens nothing. An attempt that fails (ssh refused, or a `misconfigured` hello such as a bridge of another version on the brick) writes one `ev3dev_attach_failed` line on stderr, leaves the robot `offline`, and its reason is appended to `connect` in `list_robots` until an attempt succeeds.
- **Activity** `idle | acting | running_program | stopping | fault`.
  - One moving call at a time (`drive`, `turn`, `arc`, `run_program`, a `command_device` whose command has `moves: true`): it needs `idle` and takes `acting` or `running_program` before anything is awaited, so of two calls sent together one runs and the other answers `busy` with `retry_after_ms`. Nothing is queued.
  - `stop` is allowed in every state, never waits behind a call, and aborts every call in flight (a move ends with `reason: "preempted"`). `stopping → idle` when every motor reads speed 0 and the preempted call has ended, else `fault`. Stops sent together are one stop. A verified stop in `fault` stays in `fault`. One stop at a time reaches the hardware: a `stop` and a `reset_fault` sent together run one after the other, and `reset_fault` answers with the state the robot ends in (`stop_unverified` when either could not verify).
  - `fault` = a stop could not be verified. It ends with `reset_fault` or with the verified stop of a new link's handshake (Link, above). There, reads, `stop` and `reset_fault` work; `reset_fault` verifies the stop and goes to `idle`, or answers `stop_unverified`. Outside `fault` it answers `illegal_state`.
  - Reads and commands that do not move run in every state (commands: every state but `fault`).
- **Cancellation.** When the client cancels a call (`notifications/cancelled`), a moving call is stopped by the same verified `stop` and any other call is aborted; one `{"ev":"cancelled","robot_id","tool","action"}` line goes to stderr.
- **Backstop.** A call's own limit is the runtime's (§0.10): `max_command_ms` for moves, `max_program_ms`, `timeout_ms`, `duration_ms`, a blocking command's declared bound. Describes, reads and commands that do not block have none (0). Behind it the process keeps a backstop of that limit + 2 s + `stop_worst_ms`: past it the call is aborted, a moving one is stopped, and the answer is `timeout`; its message says whether the stop was verified, could not be verified, or could not be sent. A read therefore has 2 s + `stop_worst_ms` to answer: one that crosses a slow link to an ev3dev brick and takes longer answers `timeout`.
- A moving call that fails after it started (the link dropped, the backstop passed) answers `retryable: false` with `next` starting at `read_all`: the robot may have moved, so the move is never to be sent again unread.
- **Life** of the process's robots `serving → closing → closed` (§6, Ending).

## 2. Device model

### 2.1 Shape

`DeviceSpec {id, provider, kind, roles[], channels[], commands[], description}` (types.ts). Ids are `<provider>.<local>`: `ev3.A`..`ev3.D` motors, `ev3.S1`..`ev3.S4` sensors, `ev3.pair` synced motor pair, `ev3.speaker`, `ev3.display`, `ev3.led`, `ev3.buttons`, `ev3.battery`; the twin adds `sim.world`, `sim.camera`, `sim.speaker`. Tools accept a device id or a role.

### 2.2 Conventions

Headings, turn angles and rotation rates about the vertical axis are counter-clockwise-positive seen from above (left is positive), in every channel and command: a gyro's `angle_deg` and `rate_deg_s`, an infrared sensor's `beacon_heading`, `turn` and `arc` angles, a pose heading. Motor shaft degrees (`position_deg`, `left_deg`, `right_deg`, the degrees of a motor command) are rotation in the motor's own forward direction, not headings. Channels that share a `mode_group` need a sensor mode switch; only `active` ones are read by default, and a switch happens only when the caller names the channel and the robot is idle. Providers normalize hardware that reports otherwise (the EV3 gyro is clockwise-positive natively, the infrared beacon heading is negative to the left). Distances in cm, speeds in percent unless the unit says otherwise. Image channels return `Reading.image`, never a string in `value`.

### 2.3 Kinds the providers announce (`kind` is an open string; the runtime only depends on `motor_pair` for drivetrain tools and `gyro` for headings)

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
| sim_world | pose, frame (overhead image) | load_world{world} · reset{x_cm, y_cm, heading_deg} |

**Speech is a declared capability, not a tool.** A speaker lists `speak` only when its hardware can say a text (an ev3dev brick with `espeak` and `aplay`; stock EV3 firmware cannot). The model finds it with `describe_device`; a speaker without it answers `unknown_command`. `speak` has `moves: false` and bound `{kind: "ms", max}` where `max` is the longest a phrase may last (15000): it blocks until the speech has ended (`measured.spoken: true`), is cut at `max` (reason `timeout`), or is aborted — `stop` or aborting the call cuts the audio (reason `preempted`). `voice` is an enum of what the hardware offers, `rate_wpm` is words per minute. A command that does not move and declares an `ms` bound may block that long: the runtime waits for the bound instead of `max_command_ms`, and the process's backstop (§1) stands behind that bound. The twin's `sim.speaker` makes no sound and returns at once: it records the text in `last_spoken` (and counts in `spoken_count`) so a test or a program's success condition can check what was said.

The runtime reads and commands a device through its manifest alone: a provider that announces a kind outside this table needs no change in the runtime or the tools.

**Device scans.** The runtime scans its providers' devices when the link is attached and again whenever a provider says its list changed (a sensor plugged or unplugged, a sensor mode switch that moved the `active` flags). A scan that fails after one has succeeded changes nothing: every call keeps working on the registry of the last scan that succeeded, `describe_robot` says so in `scan_error` (why the scan failed and how many times in a row; null when the registry is current), and the runtime scans again by itself after 250 ms, doubling the wait after each failure up to 5 s, until a scan succeeds or the link closes. The first scan of a link has no registry to fall back on: when it fails, the robot does not come online (§1).

## 3. Robot profile

`RobotProfile {id, roles, drivetrain?, limits, notes}`. Without `drivetrain`, `drive/turn/arc` return `unsupported`. The default EV3 profile: educator base, pair B+C, wheel 5.6 cm, axle 12 cm. Notes are facts for the model, written by whoever built the robot.

## 4. Runtime

Owns chunking: it splits every motion into operations no longer than the command's declared time bound (short ~200 ms chunks only when an `until` must be evaluated), coasting between chunks with `brake:false` only when the link's round trip is small next to the chunk time (otherwise every chunk brakes) and braking on the last. The round trip that decides is the slow end of what was measured: the 90th percentile of the provider's latest 10 timed readings, under a quarter of the chunk time. One fast answer on a slow link therefore never coasts, and after slow answers coasting returns only when they are at most one in ten. Under `until` the runtime watches the condition for the whole move: it reads the condition's devices every max(10 ms, the round trip of one such read), also while an operation runs, and aborts the operation in flight the moment the condition is met, so the reaction time is one poll plus the abort's way to the device, not the rest of a chunk. A channel's `max_rate_hz` does not slow the watch down. A condition is evaluated only when every channel it names returned a value: a reading without one is never "not met". The watch then ends the move like a met condition does (the operation in flight aborted, the device braked), one reading with nothing running measures what was done, and the call answers `condition_unreadable` with `error.measured` (§7). Any other error of the watch (the sensor's device left the registry, the link closed) ends the move the same way under its own code. `wait_until` and a program's conditions follow the same rule: they end with `condition_unreadable` at the first reading without a value. After an operation that braked, the next one is sent only after a reading taken since; after one that coasts it is sent at once, watched. It also gives every operation a deadline of ≤ 250 ms from the moment it is sent and aborts the operation there (the abort travels the same link as the request, so the device has moved for that long when it lands): that abort is a chunk end, not a preemption, and the provider answers it like any abort (motion ended, `measured` so far). `max_command_ms` is watched the same way, during the move and not only between operations: a time target is never sized past what the budget still holds, and an operation still running when the budget is spent is aborted there, so a move outlives `max_command_ms` by the abort's way to the device and the closing reading, not by the rest of a long operation. The move then ends with reason `timeout`.

Measuring a move costs no round trip of its own. The reading of the wheels (and the gyro) a move starts from is sent together with its first operation, and every later operation carries one too: **a provider serves calls in the order they were made**, so a reading made right before a command shows the device before that command starts. Progress is that reading plus the operation's own `measured`; what the device moves by itself between two operations (coasting on, creeping after a brake) shows in the next reading and is expected when the following operation is sized. One reading with nothing running closes the move, decides whether the target was reached, and is what `measured` reports. Those readings also time the link. Coasting needs a round trip timed just now: in the same call before anything moves, or at most 500 ms ago (moves sent back to back, as a program or a script does; that is how old the evidence gets between two chunks of one move). An older one is not evidence, the link may have changed: then, on a link last seen fast, the first reading is awaited. On a link last seen too slow to coast nothing is awaited, every operation brakes, and the readings show it when the link is fast again. Providers execute exactly one time-bounded operation per call. Runs in the server's process (§6). It hosts providers (`Provider` in types.ts): the EV3 provider, the ev3dev provider, the sim providers. It implements every `RobotTool` (types.ts) with the semantics in `tools.ts`, executing `until` by watching the condition while ≤ 250 ms chunks run, and programs node by node. Errors are `RuntimeError{code}` from the §7 set.

Twin: `<profile.id>-sim` is a runtime whose EV3 provider talks to a **simulated brick** (byte-level EV3 direct-command emulator backed by 2D physics), so the twin runs exactly the real EV3 code path. It adds the `sim.world`, `sim.camera` and `sim.speaker` devices.

## 5. Programs

JSON tree (`ProgramNode` in types.ts), no code. Caps: 500 nodes, `repeat.times ≤ 50`, `while.max_iterations ≤ 200`, `wait_ms ≤ 10000`, total ≤ `limits.max_program_ms`. `run_program` takes the program inline (`body`, optional `success` condition checked at the end). The runtime validates it (`validate.ts`), executes it node by node and returns per-step results.

## 6. The process

An MCP client starts it (`claude mcp add spinecord -- bun <repo>/apps/local/main.ts`). stdout carries JSON-RPC only; every log line is one JSON object on stderr.

**Robots.** Chosen on the command line or in a config file (`bun apps/local/main.ts --help` lists every option). Without arguments: the twin of the example robot (`deployments/example/robots/r1.json`) in `apps/local/examples/room.json`.

| source | runtime's providers | link |
|---|---|---|
| `twin` | simulated brick + the real EV3 provider + `sim.world` (§4 Twin), world from a JSON file | online from start |
| `ev3dev` | ev3dev provider over the system `ssh` client | connected at start; the process does not start without it. `offline` when the ssh process ends, `online` again when a new link passes the handshake (§1) |
| `ev3` | the real EV3 provider over a byte transport: the bridge page in Chrome or Edge passes WebHID reports to one WebSocket on `127.0.0.1` | `offline` until the page has an EV3 open, `offline` again when the page, the cable or the brick goes |

**Bridge page.** `apps/robot-page/bridge.html` runs no runtime and no timer on the path of a command: a browser fires the timers of a hidden or covered window once per second, and delivers socket messages and HID reports at once. The 10 ms `until` watch therefore runs in the process (measured: `apps/local/bench/results/hidden-page.json`). The process binds `127.0.0.1` by name, only when an `ev3` robot is configured, on a fixed port (default 8767; WebHID permission belongs to the origin); a taken port ends the process with a message. The socket accepts only the page the process serves, and one page: a second tab is closed with code 4009 and the reason "another tab already holds the robot", which that tab shows. The process tells the page it holds the robot (`{"t":"accepted"}`); when that socket closes, the page brakes every motor port by itself. A refused tab sends the brick nothing.

**Ending.** When stdin closes (the client went away) or the process receives SIGINT, SIGTERM or SIGHUP, every robot of the process first enters `closing` (life `serving → closing → closed`), in which every call answers `robot_offline` with `retryable: false` and a message that the server is shutting down; then it stops every online robot (verified, bounded by `stop_worst_ms`), writes one `{"ev":"stopped","robot_id","motors_stopped"}` line per robot on stderr, and exits. A process that is killed outright stops nothing itself: a stock EV3 is then braked by the bridge page, an ev3dev brick by its bridge (the ssh link closed, or 1 s of silence) or, if the bridge is dead too, by the guard process (§0.8).

## 7. Envelope and error codes

`Envelope<T>` in types.ts: `{ok, robot?, data | error, next}`; `robot` is `{id, backend, link, activity}`; `error` is `{code, message, retryable, retry_after_ms?, measured?}`, with `measured` present when the error ended a move that had started. `isError: true` when `ok:false`. Every result (success and error) carries the envelope as `structuredContent`, and every tool advertises its `outputSchema` (`ToolDef.output` in tools.ts: the envelope with that tool's `data` shape; object root, open objects, minimal `required`, so one schema accepts both outcomes). Every result validates against it; a result that does not is a JSON-RPC error, never sent as data. For clients without structured output, one `text` block repeats it: line 1 is a one-line summary, the last line is the envelope as single-line JSON. Plus one `image` block when an image channel was read. Clients that write code against the tools: `docs/code-mode.md`.

| code | retryable | meaning |
|---|---|---|
| unknown_robot / unknown_device / unknown_channel / unknown_command | no | name not found; message lists valid ones |
| unsupported | no | drive, turn or arc on a robot without a usable drivetrain; a command the brick's hardware cannot do |
| invalid_argument | no | names field, schema rule, allowed range |
| robot_offline | yes · while the process shuts down: no | the robot's link is `offline` or closed during the call (§1). A call to a robot that is already `offline` carries `connect` in its message; a call the link closed under carries the driver's reason |
| busy | yes | activity is acting/running_program/stopping; `retry_after_ms` |
| illegal_state | no | names current state and allowed tools |
| fault | no | use reset_fault after inspecting; a new link's verified stop also clears it (§1) |
| stop_unverified | no | robot is now in fault |
| timeout | yes · moving calls: no | the call outlived the process's backstop (§1) and was aborted; robot state included. A tool's own time limit is never this error: it ends the call with data (`reason: "timeout"`, `met: false`, `outcome: "timeout"`). A move that timed out may have partly happened and was stopped: read the robot before moving again |
| stale_image | yes | frame older than 1500 ms |
| condition_unreadable | no | a channel named by a condition (`until`, `wait_until`, a program's `while`, `if` or `success`) returned no value, so the condition cannot be evaluated; the message names the channel and the reading's error. A move the condition guarded was ended and braked at once, and `error.measured` holds what it had done. A channel that is null by design (an infrared beacon out of view) counts as unreadable |
| internal | no | an unexpected failure (a malformed reply from a brick, a bug); the message carries it |

`misconfigured` (no) is what a provider or the runtime throws for a bad configuration. At start it ends the process. When an `ev3dev` link is opened again it fails that attempt: the robot stays `offline`, the attempt is repeated, and `connect` carries the reason (§1). `ErrorCode` in types.ts has these codes and no other, and they are the `code` enum of every output schema.

## 8. Tools

`TOOLS` in `tools.ts`, served with `SERVER_INSTRUCTIONS`:

| group | tools |
|---|---|
| discover | `list_robots` `describe_robot` `describe_device` |
| sense | `read_device` `read_all` `sample_device` `wait_until` |
| act | `drive` `turn` `arc` `command_device` `stop` `reset_fault` |
| programs | `run_program` |

- `list_robots` returns the robots of the process: `{id, backend, link, activity, fault_reason, connect}`; `connect` tells what a person must do to bring an offline robot online. It is the one tool that addresses no robot, so its envelope has no `robot`.
- Every other tool takes `robot_id` and runs under the state of §1; the runtime executes it (§4).
- `request_id` is optional on the tools that take it and is a label (§0.5).
- A tool that moves the robot is annotated `idempotentHint: false`.
