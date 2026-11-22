# Contract v3 (2026-11-22): spinecord MCP

Audience: the model (Claude Fable 5.2) and the people who extend the robot. English only on the MCP surface.

Sources of truth, in this order: this file → `packages/protocol/types.ts` (types, FSM transition tables) → `packages/protocol/tools.ts` (tool names, descriptions, input and output schemas, server instructions, served verbatim).

spinecord runs on one computer: one bun process (`apps/local`) that serves MCP over stdio and holds the runtime (§4) and the providers of its robots. An MCP client starts it. It stores nothing.

## 0. Principles

1. **Generic primitives, no use cases.** A robot is a set of devices. A device self-describes its channels (what can be read) and commands (what it can do). The tool set is fixed; extending the robot means adding a device manifest, never a tool.
2. **Bounded by construction.** Every command declares a bound (`degrees`, `ms` or `instant`) with a max. The server checks a call's arguments against the tool's input schema; the runtime clamps args to the robot's limits, chunks what exceeds one operation, then validates what it will really send against the command's full schema. `command_device` and `drive` therefore clamp alike, on a direct call and inside a program. Clamping is reported, never hidden: `clamped: true` and `clamps: [{arg, requested, applied, target}]`, one entry per argument the runtime cut. The `reason` says whether the request was done. A cut target (a distance, an angle, a parameter of the command's bound) that was then reached ends with reason `clamped`: less was done than asked. A cut that is not the target (the speed) leaves the reason `completed`: all that was asked was done, more slowly. A device that cuts a value of its own (a tone's frequency) reports `clamped: true` the same way, with what it applied in `measured`.
3. **Explicit state machines** (§1). Illegal transitions return `illegal_state` naming the current state.
4. **Every result carries robot state and `next`.** Errors are typed (§7), never disguised as data.
5. **Nothing is stored between calls.** `request_id` is an optional label. A moving call sent twice moves twice: after a failed or unanswered moving call, read the robot (`read_all`) before moving again.
6. **Fail loud.** Missing reply, stale image, unknown device → typed error. A robot that cannot be configured ends the process at start with a message.
7. **Fast loops live next to the hardware.** The runtime (§4) executes `until` conditions and programs in the process that holds the providers: no model turn per check.
8. **Safety, honestly stated.** `stop` preempts everything. When the client goes away or the process is signalled, the process stops every robot before it exits (§6). If the process dies outright, the guarantee depends on the driver: stock EV3 firmware has no watchdog, so every motion operation is limited by **time on the brick** (≤ 250 ms, time-based opcodes, never degree-based), the robot overruns at most one chunk even against a blocked wheel, and the bridge page brakes every motor when its socket closes. An ev3dev brick's motors are run by its kernel, which ends a timed run by itself but has no time limit for a move to a position: there the limits are the bridge's (it brakes at the operation's time bound, and after 1 s of silence from the computer) and, when the bridge process itself is killed, a guard process on the brick that brakes every motor as soon as the bridge is gone. The two watch each other: a bridge whose guard is gone brakes every motor and ends, which closes the link, and the link that is opened next starts a bridge with a guard (§1), so no robot is driven without one. A bridge that hangs without ending, or a brick whose kernel fails, is covered by nothing. A provider whose device has such a watchdog may declare a longer per-operation time bound; the runtime chunks to each command's declared bound, using short chunks only while an `until` condition must be checked; then it reads the condition while every operation runs and aborts the operation the moment it is met, and it also ends every operation itself at ≤ 250 ms of motion by aborting it, so neither a chunk in flight, a slow motor nor a long declared bound delays the reaction.
9. **Reads have no side effects.** A read never changes a device. Channels needing a sensor mode switch are read only when named explicitly while idle (§2.2).
10. **One owner per rule.** Motion limits: `profile.limits` only. Chunking: the runtime only. Program and condition validation: `packages/protocol/validate.ts` only. JSON Schema validation: `packages/protocol/schema.ts` only. Time limits of a call: the runtime only; the process's backstop stands behind them (§1). Link and activity of a robot: `apps/local` only.

## 1. State machines

Per robot, two machines. Their transition tables are exported from `types.ts` (`LINK_TRANSITIONS`, `ACTIVITY_TRANSITIONS`); `apps/local` owns both and asserts every transition against them.

- **Link** `offline → handshaking → online → offline`. `handshaking` = the first device scan plus a verified stop; a robot whose stop cannot be verified there comes online in `fault`, and a verified stop there clears an earlier `fault`: a robot that was in `fault` when its link closed is `idle` once a new link has attached, without `reset_fault`. `online → offline` when the robot's link closes: for an `ev3` robot the bridge page, the cable or the brick goes; for an `ev3dev` robot the ssh process ends (the brick, the network or the bridge went away, or the bridge was silent too long). A call in flight then ends with the driver's error, and `list_robots` shows `offline` with `connect`. A twin stays `online`. An `ev3dev` robot comes back by itself: the process opens a new ssh link, and when an attempt fails it starts the next one 2 s after that attempt ended. One attempt takes as long as ssh and the bridge's hello need, at most 20 s. A link the process closed stays closed: a call still in flight on it answers `robot_offline` at once and opens nothing. An attempt that fails (ssh refused, or a `misconfigured` hello such as a bridge of another version on the brick) writes one `ev3dev_attach_failed` line on stderr, leaves the robot `offline`, and its reason is appended to `connect` in `list_robots` until an attempt succeeds. After a `misconfigured` attempt `connect` says that the robot does not come online by itself: every attempt fails the same way until a person fixes it (a bridge of another version is reinstalled with `--install-bridge` or `"install_bridge": true`), and the first attempt after that succeeds.
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

Headings, turn angles and rotation rates about the vertical axis are counter-clockwise-positive seen from above (left is positive), in every channel and command: a gyro's `angle_deg` and `rate_deg_s`, an infrared sensor's `beacon_heading`, `turn` and `arc` angles, a pose heading. Motor shaft degrees (`position_deg`, `left_deg`, `right_deg`, the degrees of a motor command) are rotation in the motor's own forward direction, not headings. Channels that share a `mode_group` need a sensor mode switch; only `active` ones are read by default, and a switch happens only when the caller names the channel and the robot is idle. Providers normalize hardware that reports otherwise (the EV3 gyro is clockwise-positive natively, the infrared beacon heading is negative to the left). A channel whose manifest says `null_when_absent: true` may answer that it has nothing to report (the infrared `beacon_heading` and `beacon_distance_pct` with no beacon in view): the reading then has value null and `absent: true`, and that null is an answer. A null without `absent` is a failed read on such a channel as on any other. In a condition every comparison on an absent reading is false (and `changed` sees it come and go), so `turn until beacon_distance_pct < 100` turns until the beacon is seen; it never answers `condition_unreadable`. `describe_device` shows the flag. A gyro's `angle_deg` is cumulative since the gyro's last reset (its `reset` command, or a mode switch), not relative to the start of a call: on a robot that has already turned, `until angle_deg lt -45` can be met at once. `turn` measures the change of heading itself; a condition on the angle needs the reset first. A channel may declare `noise`: how far two readings of a scene that did not change can lie apart, in the channel's unit (§4, `changed`). Distances in cm, speeds in percent unless the unit says otherwise. Image channels return `Reading.image`, never a string in `value`.

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

Owns chunking: it splits every motion into operations no longer than the command's declared time bound (short ~200 ms chunks only when an `until` must be evaluated), coasting between chunks with `brake:false` only when the link's round trip is small next to the chunk time (otherwise every chunk brakes) and braking on the last. The round trip that decides is the slow end of what was measured: the larger of the provider's latest timed reading and the 90th percentile of its latest 10, and it must be under a quarter of the chunk time. A link timed fewer than 3 times never coasts; the runtime times a new link up to 3 times with nothing moving, stopping at the first answer that is too slow to coast. One fast answer on a slow link therefore never coasts, a link that turns slow stops coasting at its first slow answer, and after slow answers coasting returns when the latest is fast and they are at most one in ten. Under `until` the runtime watches the condition for the whole move: it reads the condition's devices every max(10 ms, the round trip of one such read), also while an operation runs, and aborts the operation in flight the moment the condition is met, so the reaction time is one poll plus the abort's way to the device, not the rest of a chunk. A channel's `max_rate_hz` does not slow the watch down. A poll in which a channel of the condition returned no value decides nothing: the condition is not met for that poll, whatever its combinators (`not` included), and the watch polls again. Three such polls in a row on the same comparison (about 30 ms of a watched move, inside one chunk) end the watch: one lost exchange with a brick is not a broken sensor, a sensor that stays silent is. The watch then ends the move like a met condition does (the operation in flight aborted, the device braked), one reading with nothing running measures what was done, and the call answers `condition_unreadable` with `error.measured` (§7); the message names the channel, the number of polls and the reading's error. A move whose condition cannot be read when the call starts sends nothing. Any other error of the watch (the sensor's device left the registry after it was unplugged, the link closed) ends the move the same way under its own code, with `measured` when the wheels can still be read. `wait_until` and a program's `while`, `if` and `success` follow the same rule: a poll without a value is asked again 10 ms later, and the third in a row ends them with `condition_unreadable`. A channel declared `null_when_absent` (§2.2) is the exception when its reading says `absent`: that null is an answer. Ten polls in a row that decide nothing, whichever comparison lacked its value (channels failing in turn), end the watch with `condition_unreadable` too. `wait_until` ends at `timeout_ms` whatever its polls return, and a call aborted while its watch waits for an answer ends at once. After an operation that braked, the next one is sent only after a reading taken since; after one that coasts it is sent at once, watched. It also gives every operation a deadline of ≤ 250 ms from the moment it is sent and aborts the operation there (the abort travels the same link as the request, so the device has moved for that long when it lands): that abort is a chunk end, not a preemption, and the provider answers it like any abort (motion ended, `measured` so far). `max_command_ms` bounds a chunked move (`drive`, `turn`, `arc`, a `command_device` bounded in degrees or ms) while its operations run: a time target is never sized past what the budget still holds, and an operation still running when the budget is spent is aborted at that moment, so such a move outlives `max_command_ms` by the abort's way to the device and the closing reading. It ends with reason `timeout`. A command sent as one operation (an absolute target such as `run_to_position`) is aborted 250 ms after `max_command_ms`: a device that ends at its own time bound answers by itself first.

Measuring a move costs no round trip of its own. The reading of the wheels (and the gyro) a move starts from is sent together with its first operation, and every later operation carries one too: **a provider serves calls in the order they were made**, so a reading made right before a command shows the device before that command starts. Progress is that reading plus the operation's own `measured`; what the device moves by itself between two operations (coasting on, creeping after a brake) shows in the next reading and is expected when the following operation is sized. One reading with nothing running closes the move, decides whether the target was reached, and is what `measured` reports. Those readings also time the link. Coasting needs a round trip timed just now: in the same call before anything moves, or at most 500 ms ago (moves sent back to back, as a program or a script does; that is how old the evidence gets between two chunks of one move). An older one is not evidence, the link may have changed: then, on a link last seen fast, the first reading is awaited. On a link last seen too slow to coast nothing is awaited, every operation brakes, and the readings show it when the link is fast again. Providers execute exactly one time-bounded operation per call. Runs in the server's process (§6). It hosts providers (`Provider` in types.ts): the EV3 provider, the ev3dev provider, the sim providers. It implements every `RobotTool` (types.ts) with the semantics in `tools.ts`, executing `until` by watching the condition while ≤ 250 ms chunks run, and programs node by node. Errors are `RuntimeError{code}` from the §7 set.

**Conditions are checked before anything is sent.** A condition (`until`, `wait_until`, a program's `while`, `if` and `success`, and the `until` of every call in a program) is compiled against the devices when the call is planned. Three things fail there with `invalid_argument`, and the robot has not moved:

- A comparison on a channel that is not active (its sensor is in another mode of its `mode_group`): a condition never switches a sensor mode. The message says that nothing was sent and names the channel and the active ones, and `next` starts with `read_device`, which switches the mode when it names the channel (§7). When the registry said active and the device answers otherwise at the first poll, the call fails the same way and sends nothing.
- A comparison that the channel's declared `range` can never make true: `lt` at or under the low end, `lte` under it, `gt` at or over the high end, `gte` over it, `eq` outside it. `distance_cm lt 2` on a channel of range [3, 255] is refused, and the message names the range. The comparison is refused wherever it stands in the condition, also under `not`, where it would always hold.
- A drivetrain target under the smallest move: `drive`, `turn` and `arc` refuse a target that turns the leading wheel by less than 1 degree (wheel encoders count whole degrees), and the message names the minimum in the tool's own unit (0.05 cm and 0.47 degrees for the default EV3 profile). A target of exactly 0 is no motion and answers `completed` with nothing sent. A move just over the minimum overshoots by a few wheel degrees; `measured` says by how much.

**`changed`.** The comparison holds when the channel's value differs from the first value the call read. On a channel that declares `noise` (a number, or each component of a numeric vector) the difference must be larger than the noise in 2 polls in a row, so a still sensor does not meet it and one outlier does not either; that costs one poll (10 ms in a watched move). On a channel without `noise` (booleans, strings, counters, encoders) every difference is a change, at the first poll that shows it.

Twin: `<profile.id>-sim` is a runtime whose EV3 provider talks to a **simulated brick** (byte-level EV3 direct-command emulator backed by 2D physics), so the twin runs exactly the real EV3 code path. Its motors and sensors are the ones its world file declares. It adds three devices that no hardware robot has: `sim.world`, `sim.camera` and `sim.speaker` (the only speaker of a twin with `speak`).

## 5. Programs

JSON tree (`ProgramNode` in types.ts), no code. Caps: 500 nodes, `repeat.times ≤ 50`, `while.max_iterations ≤ 200`, `wait_ms ≤ 10000`, total ≤ `limits.max_program_ms`. `run_program` takes the program inline (`body`, optional `success` condition checked at the end). The runtime validates it (`validate.ts`), executes it node by node and returns per-step results: `steps: [{path, tool, ok, reason | error, measured?, clamped?, ms}]`, one per call the program made (and per `wait_ms`). A step carries the `reason` and the `measured` of the same call made outside a program, and `clamped: true` when that call cut an argument, so the result says what each step did without a read after it. A step that failed has `error: {code, message}` and, when the error ended a move, the `measured` of that move.

## 6. The process

An MCP client starts it (`claude mcp add spinecord -- bun <repo>/apps/local/main.ts`). stdout carries JSON-RPC only; every log line is one JSON object on stderr.

**Call log.** Every `tools/call` writes one line to stderr when it is answered:

```json
{"ev":"call","ts":"2026-11-22T08:19:28.089Z","tool":"drive","robot_id":"r1-sim","ok":true,"code":null,"reason":"completed","ms":350,"trace_id":null,"moved":true}
```

| field | value |
|---|---|
| `ts` | when the call was answered, ISO 8601 UTC |
| `tool`, `robot_id` | as the caller sent them, cut at 64 characters; null when absent |
| `ok`, `code` | the envelope's `ok`; the error code when `ok` is false, else null |
| `reason` | the result's `reason` (why a move or a wait ended); `run_program` gives its `outcome`; null when the result has none |
| `ms` | how long the call took in the process |
| `trace_id` | the id of an `internal` error behind this answer, else null |
| `moved` | true when a moving operation was sent to the robot during the call, or may have been (a call the backstop ended); false when nothing was sent, as for a refused argument or `busy` |

The line never holds arguments, result data or images. An `internal` error (§7) also writes `{"ev":"internal","ts","trace_id","tool","robot_id","message","stack"}` with the stack of the failure and of what caused it, cut at 4000 characters; the `trace_id` is the one in the error's message, and in a program step's `error.trace_id` when a step failed that way. To find a call: `grep '"ev":"call"'` on the server's stderr, then filter on `robot_id`, `ok` or `trace_id`.

**Robots.** Chosen on the command line or in a config file (`bun apps/local/main.ts --help` lists every option). Without arguments: the twin of the example robot (`deployments/example/robots/r1.json`) in `apps/local/examples/room.json`.

| source | runtime's providers | link |
|---|---|---|
| `twin` | simulated brick + the real EV3 provider + `sim.world` (§4 Twin), world from a JSON file | online from start |
| `ev3dev` | ev3dev provider over the system `ssh` client | connected at start; the process does not start without it. `offline` when the ssh process ends, `online` again when a new link passes the handshake (§1) |
| `ev3` | the real EV3 provider over a byte transport: the bridge page in Chrome or Edge passes WebHID reports to one WebSocket on `127.0.0.1` | `offline` until the page has an EV3 open, `offline` again when the page, the cable or the brick goes |

**Bridge page.** `apps/robot-page/bridge.html` runs no runtime and no timer on the path of a command: a browser fires the timers of a hidden or covered window once per second, and delivers socket messages and HID reports at once. The 10 ms `until` watch therefore runs in the process (measured: `apps/local/bench/results/hidden-page.json`). The process binds `127.0.0.1` by name, only when an `ev3` robot is configured, on a fixed port (default 8767; WebHID permission belongs to the origin); a taken port ends the process with a message. The socket accepts only the page the process serves, and one page: a second tab is closed with code 4009 and the reason "another tab already holds the robot", which that tab shows. The process tells the page it holds the robot (`{"t":"accepted"}`); when that socket closes, the page brakes every motor port by itself. A refused tab sends the brick nothing.

**Ending.** When stdin closes (the client went away) or the process receives SIGINT, SIGTERM or SIGHUP, every robot of the process first enters `closing` (life `serving → closing → closed`), in which every call answers `robot_offline` with `retryable: false` and a message that the server is shutting down; then it stops every online robot (verified, bounded by `stop_worst_ms`), writes one `{"ev":"stopped","robot_id","motors_stopped"}` line per robot on stderr, and exits. A process that is killed outright stops nothing itself: a stock EV3 is then braked by the bridge page, an ev3dev brick by its bridge (the ssh link closed, or 1 s of silence) or, if the bridge is dead too, by the guard process (§0.8).

## 7. Envelope and error codes

`Envelope<T>` in types.ts: `{ok, robot?, data | error, next}`; `robot` is `{id, backend, link, activity}`, with `backend` null while the robot is offline; `error` is `{code, message, retryable, retry_after_ms?, measured?}`, with `measured` present when the watch of a condition ended a move and the wheels could still be read (§4). An error that ends a move any other way (the link closed mid-drive, the backstop) carries none: read the robot. `isError: true` when `ok:false`. Every result (success and error) carries the envelope as `structuredContent`, and every tool advertises its `outputSchema` (`ToolDef.output` in tools.ts: the envelope with that tool's `data` shape; object root, open objects, minimal `required`, so one schema accepts both outcomes). Every result validates against it; a result that does not is a JSON-RPC error, never sent as data. For clients without structured output, one `text` block repeats it: line 1 is a one-line summary, the last line is the envelope as single-line JSON. Plus one `image` block when an image channel was read. Clients that write code against the tools: `docs/code-mode.md`.

**One shape per kind of answer.** `data` is an object in every tool, never a bare array, and a thing has one name wherever it appears:

| what | field | tools |
|---|---|---|
| channel values | `readings: [{device, channel, value, unit?, ts, error?, absent?}]`, one per channel; an image channel's reading is `{device, channel, value: null, image: true, mime, age_ms, ts}` | `read_device` `read_all` `wait_until` |
| the robots | `robots: [{id, backend, link, activity, fault_reason, connect}]` | `list_robots` |
| a command's result | `{requested, applied, measured, clamped, clamps?, reason, ms}`; `clamps: [{arg, requested, applied, target}]` when the runtime cut an argument (§0.2) | `drive` `turn` `arc` `command_device` |
| the readings that met `until` | `readings`, the shape above, present when `reason` is `condition_met`: a read made after the stop differs from them by the sensor's noise | `drive` `turn` `arc` `command_device` |
| what a drivetrain move measured | `measured: {distance_cm, heading_change_deg, source, left_deg, right_deg}` | `drive` `turn` `arc` |
| how long the call took | `ms` | `read_all` `wait_until` `drive` `turn` `arc` `command_device` `run_program` |
| why a call ended | `reason` | `wait_until` (`condition_met`, `timeout`, `preempted`) and every command result (`StopReason`) |

**`reason` of a command result.** `completed`: the whole request was done; `clamped` may be true beside it when an argument that is not the target was cut. `clamped`: the target was cut to a limit and the shorter target was reached. `condition_met`: `until` ended it. `stalled`, `preempted`, `timeout`: it ended early, and `measured` says how far it got. A caller tests `reason`, never `clamped`, to know whether a move did what was asked.

**`next` after an error.** An error whose fix is another tool names that tool first: a condition on a channel that is not active names `read_device`, then the same tool. Otherwise a retryable error and `invalid_argument` name the same tool first. `busy` then names `read_all` and `stop`: the call in flight ends by itself, and `stop` ends it early. `illegal_state` names `read_all`: the robot is not in `fault` and takes every other tool. A moving call that failed after it started names `read_all` first (§1).

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
| timeout | yes · moving calls: no | an answer did not come in time, in one of two ways, and the message says which. The call outlived the process's backstop (§1) and was aborted; robot state included. Or a brick did not answer one exchange within its driver's reply time (a lost reply: `ev3 no_reply`, `ev3dev: no reply`); a lost reply does not by itself close the link, and a link that is gone answers `robot_offline`. A read that lost its reply changed nothing and may be sent again. A moving call that lost a reply answers `retryable: false` with `next` starting at `read_all` (§1): the operation may have run on the brick, where it ends at its time bound. A tool's own time limit is never this error: it ends the call with data (`reason: "timeout"`, `met: false`, `outcome: "timeout"`). A move that timed out may have partly happened and was stopped: read the robot before moving again |
| stale_image | yes | frame older than 1500 ms |
| condition_unreadable | no | a channel named by a condition (`until`, `wait_until`, a program's `while`, `if` or `success`) returned no value in 3 polls in a row, so the condition cannot be evaluated (§4); the message names the channel, the count and the reading's error. A move the condition guarded was ended and braked there, and `error.measured` holds what it had done. Never for a `null_when_absent` channel (§2.2) |
| internal | no | an unexpected failure (a malformed reply from a brick, a bug); the message carries it, with a `trace_id` under which the process's log has the stack (§6, Call log) |

`misconfigured` (no) is what a provider or the runtime throws for a bad configuration. At start it ends the process. When an `ev3dev` link is opened again it fails that attempt: the robot stays `offline`, the attempt is repeated, and `connect` carries the reason (§1). `ErrorCode` in types.ts has these codes and no other, and they are the `code` enum of every output schema. `RETRYABLE` in types.ts is the one list of the codes a caller may send again; the runtime and the drivers read it.

## 8. Tools

`TOOLS` in `tools.ts`, served with `SERVER_INSTRUCTIONS`:

| group | tools |
|---|---|
| discover | `list_robots` `describe_robot` `describe_device` |
| sense | `read_device` `read_all` `sample_device` `wait_until` |
| act | `drive` `turn` `arc` `command_device` `stop` `reset_fault` |
| programs | `run_program` |

- `list_robots` returns the robots of the process: `{robots: [{id, backend, link, activity, fault_reason, connect}]}`; `connect` tells what a person must do to bring an offline robot online. It is the one tool that addresses no robot, so its envelope has no `robot`.
- Every other tool takes `robot_id` and runs under the state of §1; the runtime executes it (§4).
- `request_id` is optional on the tools that take it and is a label (§0.5).
- A tool that moves the robot is annotated `idempotentHint: false`.
- Defaults are stated in the description of their argument: `speed_pct` 30, `rate_hz` 10 (`sample_device`), `poll_hz` 20 (`wait_until`), `direction` forward (`arc`).
- `read_device` without `channels` reads the device's active non-image channels; an image channel or one that needs a mode switch is read only when named (§2.2).
