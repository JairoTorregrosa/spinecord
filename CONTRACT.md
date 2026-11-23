# Contract v3 (2026-11-22): spinecord MCP

Audience: the model (Claude Fable 5.2) and the people who extend the robot. English only on the MCP surface.

Sources of truth, in this order: this file → `packages/protocol/types.ts` (types, FSM transition tables) → `packages/protocol/tools.ts` (tool names, descriptions, input and output schemas, server instructions, served verbatim).

spinecord runs on one computer: one bun process (`apps/local`) that serves MCP over stdio and holds the runtime (§4) and the providers of its robots. An MCP client starts it. It stores nothing.

## 0. Principles

1. **Generic primitives, no use cases.** A robot is a set of devices. A device self-describes its channels (what can be read) and commands (what it can do). The tool set is fixed; extending the robot means adding a device manifest, never a tool. A behavior that must react faster than a model turn is data handed to a generic primitive: a condition (`until`), a program (§5) or a loop (§5a). No tool, node or law names a use.
2. **Bounded by construction.** Every command declares a bound (`degrees`, `ms` or `instant`) with a max. The server checks a call's arguments against the tool's input schema; the runtime clamps args to the robot's limits, chunks what exceeds one operation, then validates what it will really send against the command's full schema. `command_device` and `drive` therefore clamp alike, on a direct call and inside a program. Clamping is reported, never hidden: `clamped: true` and `clamps: [{arg, requested, applied, target}]`, one entry per argument the runtime cut. The `reason` says whether the request was done. A cut target (a distance, an angle, a parameter of the command's bound) that was then reached ends with reason `clamped`: less was done than asked. A cut that is not the target (the speed) leaves the reason `completed`: all that was asked was done, more slowly. A device that cuts a value of its own (a tone's frequency) reports `clamped: true` the same way, with what it applied in `measured`.
3. **Explicit state machines** (§1). Illegal transitions return `illegal_state` naming the current state.
4. **Every result carries robot state and `next`.** Errors are typed (§7), never disguised as data.
5. **Nothing is stored between calls, with one exception.** `request_id` is an optional label. A moving call sent twice moves twice: after a failed or unanswered moving call, read the robot (`read_all`) before moving again. The exception is the robot's loop (§5a): while it runs it is part of the robot's activity, and the report of the robot's latest loop is kept until the next loop starts or the link closes.
6. **Fail loud.** Missing reply, stale image, unknown device → typed error. A robot that cannot be configured ends the process at start with a message.
7. **Fast loops live next to the hardware.** Three rates, three places. Conditions and programs run in the server's process (§4): no model turn per check. A loop (§5a) runs where its devices' provider says: on the device itself when the provider has an executor there, else in the server's process at the rate the link carries. The model supervises a loop; it is never inside one.
8. **Safety, honestly stated.** `stop` preempts everything. When the client goes away or the process is signalled, the process stops every robot before it exits (§6). If the process dies outright, the guarantee depends on the driver: stock EV3 firmware has no watchdog, so every motion operation is limited by **time on the brick** (≤ 250 ms, time-based opcodes, never degree-based), the robot overruns at most one chunk even against a blocked wheel, and the bridge page brakes every motor when its socket closes. An ev3dev brick's motors are run by its kernel, which ends a timed run by itself but has no time limit for a move to a position: there the limits are the bridge's (it brakes at the operation's time bound, and after 1 s of silence from the computer) and, when the bridge process itself is killed, a guard process on the brick that brakes every motor as soon as the bridge is gone. The two watch each other: a bridge whose guard is gone brakes every motor and ends, which closes the link, and the link that is opened next starts a bridge with a guard (§1), so no robot is driven without one. A bridge that hangs without ending, or a brick whose kernel fails, is covered by nothing. A provider whose device has such a watchdog may declare a longer per-operation time bound; the runtime chunks to each command's declared bound, using short chunks only while an `until` condition must be checked; then it reads the condition while every operation runs and aborts the operation the moment it is met, and it also ends every operation itself at ≤ 250 ms of motion by aborting it, so neither a chunk in flight, a slow motor nor a long declared bound delays the reaction. A loop is bounded four ways: its `duration_ms`, its guards (evaluated where the loop runs), the attention window (§5a), and the link watchdog of its provider. Every one of them ends the loop with a brake of every device the loop drives. A loop output is refreshed every tick and each refresh carries a time bound enforced below the loop: on stock firmware the brick ends the motion `hold_ms` after the latest refresh.
9. **Reads have no side effects.** A read never changes a device. Channels needing a sensor mode switch are read only when named explicitly while idle (§2.2).
10. **One owner per rule.** Motion limits: the profile only (`profile.limits` for every robot, `profile.drivetrain` for the distance and the angle of a drivetrain move). Chunking: the runtime only. Program, condition and loop validation: `packages/protocol/validate.ts` only. The law of a loop: `packages/protocol/loop.ts` only (§5a). A loop's ticks, duration and guards: its executor only (§5a). A loop's report: the runtime only. The attention window, the backstop behind a loop and the `looping` activity: `apps/local` only. JSON Schema validation: `packages/protocol/schema.ts` only. Time limits of a call: the runtime only; the process's backstop stands behind them (§1). Link and activity of a robot: `apps/local` only.

## 1. State machines

Per robot, two machines. Their transition tables are exported from `types.ts` (`LINK_TRANSITIONS`, `ACTIVITY_TRANSITIONS`); `apps/local` owns both and asserts every transition against them.

- **Link** `offline → handshaking → online → offline`. `handshaking` = the first device scan plus a verified stop, tried up to 3 times when a stop is not verified within its bound (a bridge that has just started on a busy EV3 can miss the first ones); a robot none of whose 3 stops is verified there comes online in `fault`, and a verified stop there clears an earlier `fault`: a robot that was in `fault` when its link closed is `idle` once a new link has attached, without `reset_fault`. `online → offline` when the robot's link closes: for an `ev3` robot the bridge page, the cable or the brick goes; for an `ev3dev` robot the ssh process ends (the brick, the network or the bridge went away, or the bridge was silent too long). A call in flight then ends with the driver's error, and `list_robots` shows `offline` with `connect`. A twin stays `online`. An `ev3dev` robot comes online by itself, at the start of the process and each time its link has closed: the process opens an ssh link without holding up its other robots, and when an attempt fails it starts the next one 2 s after that attempt ended. A brick that is off or out of reach when the process starts is therefore `offline` with `connect`, and `online` when it answers. With `--install-bridge` an attempt first copies the bridge to the brick, until one copy has succeeded. One attempt takes as long as ssh and the bridge's hello need, at most 60 s (a busy EV3 takes 20 s and more to start Python and the bridge). A link the process closed stays closed: a call still in flight on it answers `robot_offline` at once and opens nothing. An attempt that fails (ssh refused, or a `misconfigured` hello such as a bridge of another version on the brick) writes one `ev3dev_attach_failed` line on stderr, leaves the robot `offline`, and its reason is appended to `connect` in `list_robots` until an attempt succeeds. After a `misconfigured` attempt `connect` says that the robot does not come online by itself: every attempt fails the same way until a person fixes it (a bridge of another version is reinstalled with `--install-bridge` or `"install_bridge": true`; a robot without a `pair` needs bridge version 5, a robot with one runs on version 4 too), and the first attempt after that succeeds.
- **Activity** `idle | acting | running_program | looping | stopping | fault`.
  - One moving call at a time (`drive`, `turn`, `arc`, `run_program`, a `command_device` whose command has `moves: true`): it needs `idle` and takes `acting` or `running_program` before anything is awaited, so of two calls sent together one runs and the other answers `busy` with `retry_after_ms`. Nothing is queued.
  - `stop` is allowed in every state, never waits behind a call, and aborts every call in flight (a move ends with `reason: "preempted"`). `stopping → idle` when every motor reads speed 0 and the preempted call has ended, else `fault`. Stops sent together are one stop. A verified stop in `fault` stays in `fault`. One stop at a time reaches the hardware: a `stop` and a `reset_fault` sent together run one after the other, and `reset_fault` answers with the state the robot ends in (`stop_unverified` when either could not verify).
  - `fault` = a stop could not be verified. It ends with `reset_fault` or with the verified stop of a new link's handshake (Link, above). There, reads, `stop` and `reset_fault` work; `reset_fault` verifies the stop and goes to `idle`, or answers `stop_unverified`. Outside `fault` it answers `illegal_state`.
  - Reads and commands that do not move run in every state (commands: every state but `fault`).
  - `idle → looping` when `run_loop` starts a loop. One loop per robot. `run_loop` plans the loop first: a loop it refuses leaves the robot `idle` and sends nothing. While `looping`, a moving call (`drive`, `turn`, `arc`, `run_program`, `run_loop`, a `command_device` whose command has `moves: true`) answers `busy`; its message names `supervise_loop` and `stop`, and so does its `next`. Reads run. Commands that do not move run, except on a device the loop drives (`busy`). A read that needs a sensor mode switch answers `busy`, as in every state but `idle`.
  - A loop ends by the path of `stop`: `looping → stopping → idle` when every motor reads speed 0, else `fault`. This holds whoever ends it: the `stop` tool, the loop's own duration, a guard, the attention window, an overrun, a lost input, the backstop. A link that closes while the robot is `looping` leaves it `offline` in `fault` (the stop cannot reach the hardware; the brick ends the motion at `hold_ms`), and the next link's verified stop clears it.
  - `ACTIVITY_TRANSITIONS`: `idle: [acting, running_program, looping, stopping, fault]`, `acting: [idle, stopping, fault]`, `running_program: [idle, stopping, fault]`, `looping: [stopping, fault]`, `stopping: [idle, fault]`, `fault: [idle, stopping]`.
- **Cancellation.** When the client cancels a call (`notifications/cancelled`), a moving call is stopped by the same verified `stop` and any other call is aborted; one `{"ev":"cancelled","robot_id","tool","action"}` line goes to stderr. A cancelled `run_loop` or `supervise_loop` stops the robot with the same verified `stop` as a cancelled moving call.
- **Backstop.** A call's own limit is the runtime's (§0.10): `max_command_ms` for moves, `max_program_ms`, `timeout_ms`, `duration_ms`, a blocking command's declared bound. Describes, reads and commands that do not block have none (0). Behind it the process keeps a backstop of that limit + 2 s + `stop_worst_ms`: past it the call is aborted, a moving one is stopped, and the answer is `timeout`; its message says whether the stop was verified, could not be verified, or could not be sent. A read therefore has 2 s + `stop_worst_ms` to answer: one that crosses a slow link to an ev3dev brick and takes longer answers `timeout`. `run_loop`'s own limit is its start window (20 periods, §5a); past it with the margin, the process stops the robot. `supervise_loop`'s is `wait_ms`. Behind the loop itself the process keeps a deadline of `duration_ms` + 2 s + `stop_worst_ms` from the loop's start: past it the process stops the robot and the report's reason is `timeout`.
- A moving call that fails after it started (the link dropped, the backstop passed) answers `retryable: false` with `next` starting at `read_all`: the robot may have moved, so the move is never to be sent again unread.
- **Life** of the process's robots `serving → closing → closed` (§6, Ending).

## 2. Device model

### 2.1 Shape

`DeviceSpec {id, provider, kind, roles[], channels[], commands[], description}` (types.ts). Ids are `<provider>.<local>`: `ev3.A`..`ev3.D` motors, `ev3.S1`..`ev3.S4` sensors, `ev3.pair` synced motor pair (announced only when the robot file declares `pair`, §3), `ev3.speaker`, `ev3.display`, `ev3.led`, `ev3.buttons`, `ev3.battery`; the twin adds `sim.world`, `sim.camera`, `sim.speaker`. Tools accept a device id or a role.

### 2.2 Conventions

Headings, turn angles and rotation rates about the vertical axis are counter-clockwise-positive seen from above (left is positive), in every channel and command: a gyro's `angle_deg` and `rate_deg_s`, an infrared sensor's `beacon_heading`, `turn` and `arc` angles, a pose heading. Motor shaft degrees (`position_deg`, `left_deg`, `right_deg`, the degrees of a motor command) are rotation in the motor's own forward direction, not headings. Channels that share a `mode_group` need a sensor mode switch; only `active` ones are read by default, and a switch happens only when the caller names the channel and the robot is idle. Providers normalize hardware that reports otherwise (the EV3 gyro is clockwise-positive natively, the infrared beacon heading is negative to the left). A channel whose manifest says `null_when_absent: true` may answer that it has nothing to report (the infrared `beacon_heading` and `beacon_distance_pct` with no beacon in view): the reading then has value null and `absent: true`, and that null is an answer. A null without `absent` is a failed read on such a channel as on any other. In a condition every comparison on an absent reading is false (and `changed` sees it come and go), so `turn until beacon_distance_pct < 100` turns until the beacon is seen; it never answers `condition_unreadable`. `describe_device` shows the flag. A gyro's `angle_deg` is cumulative since the gyro's last reset (its `reset` command, or a mode switch), not relative to the start of a call: on a robot that has already turned, `until angle_deg lt -45` can be met at once. `turn` measures the change of heading itself; a condition on the angle needs the reset first. A channel may declare `noise`: how far two readings of a scene that did not change can lie apart, in the channel's unit (§4, `changed`). Distances in cm, speeds in percent unless the unit says otherwise. Image channels return `Reading.image`, never a string in `value`.

### 2.3 Kinds the providers announce (`kind` is an open string; the runtime only depends on `motor_pair` for drivetrain tools; the heading of a drivetrain is the channel its profile names, §3)

| kind | channels | commands |
|---|---|---|
| motor | position_deg, speed_deg_s, stalled, power_pct (the duty cycle being applied) | run_degrees{degrees, speed_pct} · run_time{ms, speed_pct} (`drives` speed_pct) · power{power_pct, ms} (unregulated power for `ms`, then brake; bound `ms`; `drives` power_pct) · run_to_position{position_deg, speed_pct} · brake{} · reset_position{} |
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

**Loop outputs (`drives`).** A command may declare `drives: {arg, max_hold_ms}`: a loop may refresh this command every tick with a new value of the numeric argument `arg`; a refresh supersedes the one in flight on that device, and the device ends the command's effect by itself when no refresh follows. `max_hold_ms` is the longest the device lets one refresh last (0 for a command with no lasting motion, such as a light). Only commands with `drives` can be loop outputs; `describe_device` shows them. On stock firmware `run_time` and `power` declare it with `max_hold_ms` 250, and a refreshed value that rounds to 0 brakes the motor. The stock `power_pct` channel is what the provider's latest `power` command or refresh applies while it lasts: the firmware does not report it.

**Loop inputs.** Any channel of type `number` or `boolean` (false = 0, true = 1) that is `active`, and one component of a numeric `vector` channel (`index`). A loop never switches a sensor mode: a channel that is not active is refused when the loop is planned, with `next` starting at `read_device` (the rule of conditions, §4).

**Device scans.** The runtime scans its providers' devices when the link is attached and again whenever a provider says its list changed (a sensor plugged or unplugged, a sensor mode switch that moved the `active` flags). A scan that fails after one has succeeded changes nothing: every call keeps working on the registry of the last scan that succeeded, `describe_robot` says so in `scan_error` (why the scan failed and how many times in a row; null when the registry is current), and the runtime scans again by itself after 250 ms, doubling the wait after each failure up to 5 s, until a scan succeeds or the link closes. The first scan of a link has no registry to fall back on: when it fails, the robot does not come online (§1).

## 3. Robot profile

`RobotProfile {id, roles, drivetrain?, limits, notes}`. Notes are facts for the model, written by whoever built the robot.

- `limits`: `max_speed_pct`, `max_command_ms`, `max_program_ms`, `max_loop_ms` (the longest life of one loop). They hold for every robot, with or without wheels.
- `drivetrain` (optional): `{type: "differential", pair_device, wheel_diameter_cm, axle_track_cm, forward_sign, max_drive_cm, max_turn_deg, heading?: {device, channel}}`. `max_drive_cm` and `max_turn_deg` are the longest distance and the largest angle of one `drive`, `turn` or `arc`. `heading` names the channel that measures rotation about the vertical axis in degrees (§2.2); `device` is a device id (`<provider>.<local>`) or a role of `profile.roles`; a robot file whose `heading.device` is neither is refused when it is read. Without `heading`, `drive`, `turn` and `arc` measure the heading from the wheel encoders. The runtime never picks a heading device by kind or by role. A declared heading is never skipped in silence. Devices come and go while a robot is online (a sensor unplugged, another one on its port), so a heading that cannot be used does not end the start; it shows in two places. `describe_robot` has `heading_error`: null when the drivetrain names no heading or the named channel can be used, else a sentence that says why not (the device is not attached, it has no numeric channel of that name, the channel is not active because its sensor is in another mode). And a move that names a heading and could not measure with it (one of those reasons, or a read of the channel that gave no number at the start or at the end of the move) measures the heading from the wheel encoders and says so twice: `measured.source` is `encoders`, and `measured.heading_error` holds the reason. `measured.source` is `gyro` when the heading channel measured the move, and `measured` then has no `heading_error`. A robot whose drivetrain names no heading answers `source: "encoders"` with no `heading_error`.
- A robot file is `{hardware, profile, pair?}`. `pair` (`{left, right}` motor ports) exists only for a robot whose two motors are driven as one synchronized device; the provider announces `<id>.pair` only then, and without it those two ports are two `motor` devices. A `drivetrain` needs the `pair` its `pair_device` names: a robot file with a `drivetrain` and no `pair` is refused when it is read.
- A robot without `pair` and without `drivetrain` is complete: its motors and sensors are devices, `drive`, `turn` and `arc` answer `unsupported` with `next` starting at `describe_robot` and `command_device`, and everything else works. `describe_robot` shows `drivetrain: null`, and the `next` of a result on such a robot names `command_device` where it names `drive`, `turn` or `arc` on a robot with wheels. Its twin's motors turn and its body stays where the world put it.
- The example robots are `deployments/example/robots/r1.json` (a two-wheel base: pair B+C, wheel 5.6 cm, axle 12 cm, heading from its gyro) and `deployments/example/robots/arm.json` (two free motors and a sensor, no pair, no drivetrain).

## 4. Runtime

Owns chunking: it splits every motion into operations no longer than the command's declared time bound (short ~200 ms chunks only when an `until` must be evaluated), coasting between chunks with `brake:false` only when the link's round trip is small next to the chunk time (otherwise every chunk brakes) and braking on the last. The round trip that decides is the slow end of what was measured: the larger of the provider's latest timed reading and the 90th percentile of its latest 10, and it must be under a quarter of the chunk time. A link timed fewer than 3 times never coasts; the runtime times a new link up to 3 times with nothing moving, stopping at the first answer that is too slow to coast. One fast answer on a slow link therefore never coasts, a link that turns slow stops coasting at its first slow answer, and after slow answers coasting returns when the latest is fast and they are at most one in ten. Under `until` the runtime watches the condition for the whole move: it reads the condition's devices every max(10 ms, the round trip of one such read), also while an operation runs, and aborts the operation in flight the moment the condition is met, so the reaction time is one poll plus the abort's way to the device, not the rest of a chunk. A channel's `max_rate_hz` does not slow the watch down. A poll in which a channel of the condition returned no value decides nothing: the condition is not met for that poll, whatever its combinators (`not` included), and the watch polls again. Three such polls in a row on the same comparison (about 30 ms of a watched move, inside one chunk) end the watch: one lost exchange with a brick is not a broken sensor, a sensor that stays silent is. The watch then ends the move like a met condition does (the operation in flight aborted, the device braked), one reading with nothing running measures what was done, and the call answers `condition_unreadable` with `error.measured` (§7); the message names the channel, the number of polls and the reading's error. A move whose condition cannot be read when the call starts sends nothing. Any other error of the watch (the sensor's device left the registry after it was unplugged, the link closed) ends the move the same way under its own code, with `measured` when the wheels can still be read. `wait_until` and a program's `while`, `if` and `success` follow the same rule: a poll without a value is asked again 10 ms later, and the third in a row ends them with `condition_unreadable`. A channel declared `null_when_absent` (§2.2) is the exception when its reading says `absent`: that null is an answer. Ten polls in a row that decide nothing, whichever comparison lacked its value (channels failing in turn), end the watch with `condition_unreadable` too. `wait_until` ends at `timeout_ms` whatever its polls return, and a call aborted while its watch waits for an answer ends at once. After an operation that braked, the next one is sent only after a reading taken since; after one that coasts it is sent at once, watched. It also gives every operation a deadline of ≤ 250 ms from the moment it is sent and aborts the operation there (the abort travels the same link as the request, so the device has moved for that long when it lands): that abort is a chunk end, not a preemption, and the provider answers it like any abort (motion ended, `measured` so far). `max_command_ms` bounds a chunked move (`drive`, `turn`, `arc`, a `command_device` bounded in degrees or ms) while its operations run: a time target is never sized past what the budget still holds, and an operation still running when the budget is spent is aborted at that moment, so such a move outlives `max_command_ms` by the abort's way to the device and the closing reading. It ends with reason `timeout`. A command sent as one operation (an absolute target such as `run_to_position`) is aborted 250 ms after `max_command_ms`: a device that ends at its own time bound answers by itself first.

Measuring a move costs no round trip of its own. The reading of the wheels (and of the drivetrain's heading channel, when the profile names one) a move starts from is sent together with its first operation, and every later operation carries one too: **a provider serves calls in the order they were made**, so a reading made right before a command shows the device before that command starts. Progress is that reading plus the operation's own `measured`; what the device moves by itself between two operations (coasting on, creeping after a brake) shows in the next reading and is expected when the following operation is sized. One reading with nothing running closes the move, decides whether the target was reached, and is what `measured` reports. Those readings also time the link. Coasting needs a round trip timed just now: in the same call before anything moves, or at most 500 ms ago (moves sent back to back, as a program or a script does; that is how old the evidence gets between two chunks of one move). An older one is not evidence, the link may have changed: then, on a link last seen fast, the first reading is awaited. On a link last seen too slow to coast nothing is awaited, every operation brakes, and the readings show it when the link is fast again. Providers execute exactly one time-bounded operation per call. Runs in the server's process (§6). It hosts providers (`Provider` in types.ts): the EV3 provider, the ev3dev provider, the sim providers. It implements every `RobotTool` (types.ts) with the semantics in `tools.ts`, executing `until` by watching the condition while ≤ 250 ms chunks run, and programs node by node. Errors are `RuntimeError{code}` from the §7 set.

**Operations and ticks.** `Provider.command` executes exactly one time-bounded operation and resolves when it has ended; a device that runs one refuses a second (`busy`). `Provider.loop` is the other way, and only a loop uses it. A provider that has it declares one of two shapes (`ProviderLoop` in types.ts):

```ts
type ProviderLoop =
  | { runs_on: "host"; max_rate_hz: number;
      // One exchange with the hardware: refreshes every output, then reads every input, in that order.
      // A refresh supersedes the refresh in flight on its device and is bounded on the device at hold_ms.
      tick(writes: {device: string; command: string; args: Record<string, Value>}[],
           reads: {device: string; channel: string; index?: number}[],
           hold_ms: number): Promise<(number | null)[]>;
      // Brakes the driven devices and releases them.
      end(devices: string[]): Promise<void> }
  | { runs_on: "device"; max_rate_hz: number;
      // Hands the planned loop to the device, which runs it by itself and pushes telemetry and its end.
      start(plan: LoopPlan, on: (ev: LoopEvent) => void): Promise<{
        set(params: Record<string, number>, ramp_ms: number): Promise<void>;
        end(): Promise<void>;                 // brakes; `ended` then resolves with reason preempted
        ended: Promise<LoopEnd> }> };
```

A device that a loop drives is claimed for the life of the loop: `command` on it answers `busy`. The 250 ms rule of §0.8 holds for ticks through `hold_ms`. The runtime's host executor is one timer on the runtime's clock, with absolute deadlines (tick n is due at start + n × period), calling `tick` once per period and `packages/protocol/loop.ts` between two ticks; a tick refreshes each output with what the law computed on the previous tick. A stock provider's tick is one direct command, and a stop overtakes a tick still waiting in the queue: that tick goes out without its refreshes.

**Conditions are checked before anything is sent.** A condition (`until`, `wait_until`, a program's `while`, `if` and `success`, and the `until` of every call in a program) is compiled against the devices when the call is planned. Two things fail there with `invalid_argument`, and the robot has not moved:

- A comparison on a channel that is not active (its sensor is in another mode of its `mode_group`): a condition never switches a sensor mode. The message says that nothing was sent and names the channel and the active ones, and `next` starts with `read_device`, which switches the mode when it names the channel (§7). When the registry said active and the device answers otherwise at the first poll, the call fails the same way and sends nothing.
- A comparison that the channel's declared `range` can never make true: `lt` at or under the low end, `lte` under it, `gt` at or over the high end, `gte` over it, `eq` outside it. `distance_cm lt 2` on a channel of range [3, 255] is refused, and the message names the range. The comparison is refused wherever it stands in the condition, also under `not`, where it would always hold.

**The smallest move of a drivetrain.** Wheel encoders count whole degrees, so the smallest target of `drive`, `turn` and `arc` is the one that turns the leading wheel by 1 degree: 0.05 cm and 0.47 degrees for the example base (§3). A nonzero target under it, of either sign, is answered as done: nothing is sent, the result is `ok` with reason `completed`, the target in `applied` is 0, `measured` is what the wheels read (about 0), and `note` is one sentence that names the minimum in the tool's own unit. A script that computes a correction (`turn(90 - measured)`) therefore goes on when the correction is too small to make. The call is still planned like any move: its `until` is compiled, and the robot must be online and idle. A program step answers the same way and carries the `note`. A target of exactly 0 is no motion and answers `completed` with nothing sent and no `note`. A move just over the minimum overshoots by a few wheel degrees; `measured` says by how much.

**`changed`.** The comparison holds when the channel's value differs from the first value the call read. On a channel that declares `noise` (a number, or each component of a numeric vector) the difference must be larger than the noise in 2 polls in a row, so a still sensor does not meet it and one outlier does not either; that costs one poll (10 ms in a watched move). On a channel without `noise` (booleans, strings, counters, encoders) every difference is a change, at the first poll that shows it.

Twin: `<profile.id>-sim` is a runtime whose EV3 provider talks to a **simulated brick** (byte-level EV3 direct-command emulator backed by 2D physics), so the twin runs exactly the real EV3 code path. Its motors and sensors are the ones its world file declares. It adds three devices that no hardware robot has: `sim.world`, `sim.camera` and `sim.speaker` (the only speaker of a twin with `speak`).

## 5. Programs

JSON tree (`ProgramNode` in types.ts), no code. Caps: 500 nodes, `repeat.times ≤ 50`, `while.max_iterations ≤ 200`, `wait_ms ≤ 10000`, total ≤ `limits.max_program_ms`. `run_program` takes the program inline (`body`, optional `success` condition checked at the end). The runtime validates it (`validate.ts`), executes it node by node and returns per-step results: `steps: [{path, tool, ok, reason | error, measured?, clamped?, note?, ms}]`, one per call the program made (and per `wait_ms`). A step carries the `reason` and the `measured` of the same call made outside a program, and `clamped: true` when that call cut an argument, so the result says what each step did without a read after it. A step that failed has `error: {code, message}` and, when the error ended a move, the `measured` of that move.

## 5a. Loops

A loop is a control law that runs at a fixed rate next to the hardware: every tick it reads its input signals, computes each output, and refreshes each output device. It is given as data, like a program, and is bounded by construction. This section is the law and its data: `LoopSpec` and the types beside it in types.ts, `validateLoop` in `validate.ts`, and `planLoop`, `stepLoop` and `setParams` in `packages/protocol/loop.ts`, which are pure (no I/O, no clock). No use is named anywhere in it: balancing, following a line or a wall, and holding an arm at an angle are each one `LoopSpec` (`docs/loops.md`).

**Shape** (`LoopSpec` in types.ts):

```
{
  rate_hz,                       // ticks per second
  duration_ms,                   // the loop ends by itself at this age; cut to the robot's limit on a loop's life (reported)
  attention_ms?,                 // default 15000: how long a loop may run unsupervised
  signals: { <name>: { device, channel, index?, zero?, detrend_s?, smooth_ms? } },
  params?: { <name>: number },   // named numbers the law refers to; the only thing that changes while a loop runs
  outputs: [ { device, command, args?, terms: [Term, ...], limit?: [lo, hi] } ],
  guards?: [ { name, signal, of?, op, value, for_ms? } ],
  trace_hz?                      // default 10, at most 20
}
Term = { signal, of?, setpoint?, gain, clamp? }  // feedback on one part of one signal; of: value (default) | integral | derivative
     | { feed, gain? }                          // feedforward: gain × the value of param `feed`; gain defaults to 1
```

A `setpoint`, a `gain` and a `feed` are each a number or the name of a param. Caps: 8 signals, 4 outputs, 16 terms per output, 8 guards, 16 params.

**Loop inputs and outputs.** A signal reads a channel of type `number` or `boolean` (false = 0, true = 1), or one component of a numeric `vector` channel (`index`). A loop never switches a sensor mode: a channel that is not `active` is refused when the loop is planned, with `next` starting at `read_device` (the rule of conditions, §4). An output refreshes one command every tick with a new value of one numeric argument. Only a command with `drives: {arg, max_hold_ms}` (`LoopDrives`) can be an output; a plan is handed it per output (Planning, below). `arg` is that argument, and `max_hold_ms` is the longest the device lets one refresh last (0 for a command with no lasting motion). A loop holds each refresh for `hold_ms` = 3 periods, at least 30 ms, at most `max_hold_ms`. `args` holds the command's other arguments, the same on every refresh. 0 is the value an output rests at: every output is 0 while the loop settles and on the tick that ends it, whatever its `limit`, so the range of `arg` must hold 0.

**Ticks.** dt is the measured time between two ticks, in milliseconds; the law reads no clock. The first tick has no dt: on it every derivative is 0 and every integral is 0. A tick with a dt of 0 is a tick: its reading is taken, guards see it, and only the derivative keeps the value it had. A tick whose dt is above 10 periods ends the loop with reason `overrun`: the law never integrates across such a hole. A tick on which a channel returns no value keeps that signal's value and derivative; the next reading's derivative and filters span the whole gap. A reading that is not a finite number, or lies beyond ±1e9, is no value. Three ticks in a row without a value end the loop with reason `input_lost`. On the tick that ends a loop, whatever the reason, every output is 0.

**Magnitudes.** No output can leave the finite numbers, so none that is not a number reaches a device. Every gain, setpoint, feed, param, `clamp` and guard value lies within ±1e6, `detrend_s` and `smooth_ms` are at most 1e6, readings lie within ±1e9, and the law holds every derivative, every signal integral and every term's accumulator within ±1e12.

**Signals.** Each tick a signal has a `value`: the channel's reading after `zero`, `detrend_s` and `smooth_ms`, in that order.
- `zero: "start"` subtracts the first reading the loop takes of the channel (an encoder, a cumulative angle). `zero: {mean_ms}` holds every output at 0 for `mean_ms` from the signal's first reading, subtracts the mean of the readings it took in that time, and ends the loop with reason `not_still` when those readings spread more than 4 × the channel's `noise` (the offset of a rate gyro). Absent: the reading as it is. While any signal measures its mean the law has not started: filters, derivatives, integrals and guards begin on the first tick after, which is the law's first tick.
- `detrend_s` subtracts a running mean with that time constant (slow drift of a rate sensor): each tick the mean moves toward the reading by dt / (`detrend_s` + dt) of their difference. The mean starts at the signal's reading on the law's first tick.
- `smooth_ms` is a first-order low-pass with that time constant: each tick the value moves toward its input by dt / (`smooth_ms` + dt) of their difference. It starts at its input on the law's first tick.
- The derivative of a signal is the change of its `value` over dt.

**Law.** For every output, every tick, `u` is the sum of its terms:

| term | contributes |
|---|---|
| `of: value` | gain × (value − setpoint) |
| `of: derivative` | gain × (d(value)/dt − setpoint); the setpoint is a rate, per second |
| `of: integral` | gain × I, where I is the term's own accumulator: I grows by (value − setpoint) × dt each tick and starts at 0. With `clamp`, I is held within ±`clamp` (in the signal's unit × seconds) |
| `feed` | gain × the param |

A setpoint is 0 when absent. Then `u` is cut to `limit` and to the `minimum` and `maximum` of the command's `drives.arg` in its `params` schema, and the command is refreshed with it. An accumulator is a state of the law like any other: it follows its signal whatever the output does, and only its own `clamp` bounds it. A PID on one signal is three terms on it (value, integral with a `clamp`, derivative). State feedback is one term per state, with the integral and the derivative giving the states a sensor does not report (the angle of a rate gyro, the speed of an encoder). A positive gain raises the output when the signal is above its setpoint: an actuator that raises the signal it is regulated on takes negative gains.

**Params.** `setParams` changes named numbers between two ticks, all of them on the same tick; with `ramp_ms` (at most 3600000) each moves to its new value linearly over that much loop time, from the value it has on that tick, also in the middle of another ramp. A new value lies within ±1e6 and names an existing param, else `invalid_argument`. Integrals and filters keep their state. Signals, terms, guards, limits and the rate are fixed for the life of a loop: a different law is a new loop.

**Guards.** `{name, signal, of: value | integral | derivative (default value), op: gt | lt | abs_gt, value, for_ms?}`. A guard's `integral` is the sum of value × dt since the law's first tick, with no setpoint. A guard that holds on a tick (on every tick of `for_ms` in a row when given) ends the loop on that tick, where the loop runs, with reason `guard` and the guard's `name`; of two guards that hold on the same tick the first of the list gives the name. A guard is how a loop says "fallen", "line lost", "bumper pressed" or "arrived": the caller decides what the name means.

**Validation.** `validateLoop` checks a spec without a robot, and every failure is `invalid_argument` with the path of the field (`loop.outputs[1].terms[0].gain`): the caps above; unknown keys; `rate_hz` of at least 0.1; `duration_ms` and `attention_ms` integers of at least 1; `trace_hz` above 0 and at most 20; at least one signal and one output; names of signals, params and guards made of 1 to 32 letters, digits and `_`, not starting with a digit and never `__proto__`; `device`, `channel` and `command` strings of 1 to 64 characters; a signal never named `t_ms` or `out<i>` (keys of the trace); `index` an integer of at least 0; `zero` either `"start"` or `{mean_ms}` with `mean_ms` an integer from 1 to under `duration_ms`; `detrend_s` and `smooth_ms` above 0 and at most 1e6; no two outputs with the same `device` string; `limit` two numbers with lo ≤ hi; a term either feedback or feed, never both; `clamp` above 0, at most 1e6, and only on a term of integral; a guard's `name` unique, its `op` one of the three, its `value` within ±1e6, its `for_ms` an integer of at least 1; every signal a term or a guard names exists; every `setpoint`, `gain` and `feed` a number within ±1e6 or the name of an existing param; every param within ±1e6.

**Planning.** `planLoop` checks a spec against the robot and returns a `LoopPlan`: every default filled in, signals and outputs in the spec's order, every device by its id, each output with its `hold_ms` and its bounds (`limit` cut to the range of `drives.arg`). What it needs from the robot comes as data (`LoopContext`): per signal the channel's manifest entry and the id of its device, per output the id of its device, the command's `drives` and the range of its argument, `max_rate_hz` and `max_loop_ms`. A context that lacks a device id, or holds a number that is none (a negative `noise` or `max_hold_ms`, a rate of 0), is `misconfigured`. It refuses a spec `validateLoop` refuses, and it refuses, and nothing is slowed, switched or dropped silently:

| refused | code |
|---|---|
| `rate_hz` above `max_rate_hz`, the fastest rate where the loop runs; the message names the maximum | `invalid_argument` |
| a channel that is not `active`; `next` starts with `read_device` | `invalid_argument` |
| a channel of type `string` or `image`; a `vector` channel without `index` or with one outside its length; an `index` on a channel that is no vector | `invalid_argument` |
| `args` that hold the argument the loop computes | `invalid_argument` |
| two outputs on one device, whatever each calls it (an id and a role of the same motor); the message names the device id | `invalid_argument` |
| a `limit` that lies outside the range of `drives.arg` | `invalid_argument` |
| a command without `drives`, or whose `drives.arg` has no `minimum` and `maximum`, or a range that leaves out 0 | `unsupported` |

`duration_ms` above `max_loop_ms`, the robot's limit on a loop's life, is cut to it and reported in the plan's `clamps` (§0.2). A signal whose channel declares `max_rate_hz` under the loop's rate is sampled at the loop's rate and holds its value between the sensor's own updates; the plan names it in `notes`.

**What a loop reports** (`LoopReport`): `{state, reason?, guard?, runs_on, rate_hz, age_ms, remaining_ms, ticks, overruns, period_ms: {p50, p95, max}, signals: {<name>: {last, min, max, mean, integral, derivative}}, outputs: [{device, command, last, min, max, mean_abs, saturated_pct}], params, trace: {t_ms: [...], <signal name>: [...], out<i>: [...]}, notes?}`. The statistics cover the ticks since the previous report; `integral` and `derivative` are the signal's latest; `saturated_pct` is the share of ticks on which the output was cut. The trace is sampled at `trace_hz` and holds at most 200 points, the latest ones. Ticks earlier than the law's first are in neither. The tick that ends a loop is in both, with its reading and its outputs at 0, and always has a point in the trace.

**Why a loop ends** (`LoopEndReason`). The law itself ends a loop with `guard`, `input_lost`, `not_still` or, for a tick later than 10 periods, `overrun`; the others belong to whoever runs it. A step of a loop that has ended answers the same end, with the guard's name, and outputs at 0.

| reason | meaning |
|---|---|
| `completed` | `duration_ms` passed |
| `guard` | a guard held; `guard` is its name |
| `preempted` | it was stopped from outside |
| `unattended` | `attention_ms` passed with nobody supervising it |
| `overrun` | `rate_hz` could not be held; from the law: one tick came more than 10 periods late |
| `input_lost` | a signal's channel returned no value on 3 ticks in a row, while the loop settles or while the law runs |
| `not_still` | a `zero: {mean_ms}` measurement saw motion |
| `timeout` | a backstop behind the loop ended it |

**One law.** `packages/protocol/loop.ts` is the law. `packages/protocol/loop-golden.json` holds cases of `{spec, ctx, plan, ticks: [{set?, inputs, dt, expect: {outputs, guard?, end?, signals}}]}` that cover every term kind, zero mode, filter, guard and limit, a tick without a value, a dt of 0, a late tick and a param set in the middle of a ramp; its `note` says where each number comes from and what a port to Python 3.5 must mind; an implementation of the law in another language computes the same outputs from the same inputs, tick for tick, and is tested with the same file. The law therefore uses only + − × ÷, in a fixed order.

**Where it runs.** Every provider declares `loop: {runs_on, max_rate_hz}` or declares none; `describe_robot` reports it as `loop` (null when no provider of the robot runs loops).

| provider | `runs_on` | executor |
|---|---|---|
| stock EV3 | `host` | the runtime, in the server's process: one packet per tick carries every output refresh and every input read |
| twin | `host` | the same executor and the same provider over the simulated brick |
| ev3dev | none | `describe_robot` shows `loop: null`; `run_loop` answers `unsupported` |

Declared `max_rate_hz`: stock EV3 50, twin 100. Each is a constant of its provider's transport. The stock figure is conservative and not a measurement: no loop has run on a real brick (`docs/hardware-log.md`).

The devices a loop names decide the executor; the caller does not choose. A loop whose devices all belong to `host` providers runs in the runtime, at the lowest `max_rate_hz` among them. A loop that names a device of a provider without a loop, or of a `device` provider, is refused with `unsupported`.

**Rate.** `rate_hz` above the executor's `max_rate_hz` is refused with `invalid_argument`; the message names the maximum and where the loop runs. Nothing is slowed silently. A running loop that cannot hold its rate ends with reason `overrun`: 3 ticks in a row later than one period, or more than 5 % of the ticks of any second once a second has passed. The report counts the late ticks in `overruns`.

**Supervision.** `run_loop` plans the loop (devices, channels, `drives`, ranges, rate: everything is checked first, and a failed check sends nothing), starts it, and answers when the first 20 ticks have run or the loop has ended, whichever comes first. The robot is then `looping` and no call is in flight, so the model is free to think. `supervise_loop` is the one way in:
- it returns the loop's report: `state: running | ended`, the reason once ended, tick statistics, per-signal and per-output statistics since the previous report, and a trace sampled at `trace_hz`;
- `params` changes named numbers on a tick boundary (all of them on the same tick); `ramp_ms` (at most 10000 through the tool) moves them there linearly;
- `wait_ms` holds the call open until the loop ends or the time passes, so a caller with nothing to change waits in one call.

A report of an ended loop is answered once the robot has taken the path of `stop` after it (§1), so its `robot.activity` is `idle` or `fault`. After the end, `supervise_loop` keeps returning the final report, unchanged (its trace and statistics included), until the next `run_loop`; on a robot that has run no loop on this link it answers `illegal_state`, with `next` starting at `run_loop`.

The **attention window** makes supervision a duty: a loop ends with reason `unattended` when `attention_ms` have passed with no `supervise_loop` answered and none pending, counted from the answer of `run_loop`. A model that has moved on, or a person who interrupted it, therefore ends the loop.

Why not a blocking call for the whole loop: a model reads a result only when its call returns, so it could never steer a loop it is waiting on. Why not a model turn per tick: a turn takes seconds; a tick takes milliseconds.

**How the host executor ends a loop.** Beside the ends of the law: `completed` when the tick due at an age of `duration_ms` or more comes (it is not sent); `overrun` by the rule above; `input_lost` when a tick's exchange fails (no reply, a link that closed) or a signal's device leaves the registry; `preempted` when `stop` (or a cancelled call) reaches the runtime. `unattended` and `timeout` come from the process (§1). The first cause wins: a later one changes nothing.

**Safety.**
- Bounded: `duration_ms` ≤ `limits.max_loop_ms`, counted on the executor's own clock.
- Every end brakes every device the loop drives, first, ahead of any bookkeeping or output, and is then verified by the path of `stop` (§1). A brake that fails, or does not answer within `stop_worst_ms`, is named in the report's `notes`; the loop ends at that bound all the same, takes the verified stop, and leaves the robot in `fault` whatever the motors read.
- `stop` preempts a loop like any move and is verified.
- Guards run on the executor, on the tick that reads the signal.
- Link silence. Stock and twin: a tick whose packet is not answered ends the loop; the brick ends the motion `hold_ms` after the latest refresh, and the bridge page brakes every motor when its socket closes.
- `hold_ms` of a motor output is at most 250 ms on stock firmware (`max_hold_ms` of its motor commands), so a loop that dies leaves a motor running for at most that long.
- No silent fallback anywhere: a rate, a device mix, a channel or a command the executor cannot honor is a typed refusal at planning time, and so is an output's fixed `args` entry that is not a param of its command or breaks the param's schema (`invalid_argument`).
- A stock provider's end brake overtakes every tick still waiting in the queue, and a tick planned while the loop ran carries no refresh once it has ended: the brake is the last command a driven port gets from the loop.

A loop whose link closes leaves the robot `offline`; calls then answer `robot_offline`, and the report is gone with the link.

## 6. The process

An MCP client starts it (`claude mcp add -s user spinecord -- bun <repo>/apps/local/main.ts`; `bun apps/local/main.ts --print-add` prints that command with the absolute path, quoted for the shells of the computer it runs on; on Windows the separator is printed as `"--"`). stdout carries JSON-RPC only; every log line is one JSON object on stderr. With `--log-file <path>` each of those lines is also appended to that file, written when it is logged, so the lines of a process that ends are in it. The path follows the rule of every path on the command line (absolute as it is, a leading `~` the home folder, relative from the repository root); the file's folder is created; a file that cannot be opened ends the start with exit code 1 and the path on stderr. A write to the file that fails while the server runs (a full disk) stops nothing: the file is given up, one `{"ev":"log_file_failed","path","error"}` line goes to stderr, and the server serves, stops its robots and exits as without the flag. `--print-add` carries the flag with the absolute path.

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

`run_loop` and `supervise_loop` write the call line of every tool; its `reason` is the report's `reason` (null while the loop runs) and `moved` is true for `run_loop` once the loop has started. The end of a loop, whoever caused it, writes one more line: `{"ev":"loop_end","ts","robot_id","reason","guard","runs_on","ticks","overruns","ms"}`. It holds no signal value and no trace.

The line never holds arguments, result data or images. An `internal` error (§7) also writes `{"ev":"internal","ts","trace_id","tool","robot_id","message","stack"}` with the stack of the failure and of what caused it, cut at 4000 characters; the `trace_id` is the one in the error's message, and in a program step's `error.trace_id` when a step failed that way. To find a call: `grep '"ev":"call"'` on the server's stderr or its `--log-file`, then filter on `robot_id`, `ok` or `trace_id`.

**Robots.** Chosen on the command line or in a config file (`bun apps/local/main.ts --help` lists every option). Without arguments: the twin of the example robot (`deployments/example/robots/r1.json`) in `apps/local/examples/room.json`. `--twin`, `--ev3` and `--ev3dev` without a robot file use that example robot. A relative path on the command line is taken from the repository root, one in a config file from that file's folder; the working directory of the process decides nothing. A file that is not there ends the start with its absolute path.

| source | runtime's providers | link |
|---|---|---|
| `twin` | simulated brick + the real EV3 provider + `sim.world` (§4 Twin), world from a JSON file | online from start |
| `ev3dev` | ev3dev provider over the system `ssh` client | `offline` at start, `online` when a link passes the handshake (§1); the process starts and serves its other robots whether or not the brick answers. `offline` when the ssh process ends, `online` again when a new link passes the handshake |
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
| a command's result | `{requested, applied, measured, clamped, clamps?, reason, note?, ms}`; `clamps: [{arg, requested, applied, target}]` when the runtime cut an argument (§0.2); `note` when a drivetrain target is under the smallest move and nothing was sent (§4) | `drive` `turn` `arc` `command_device` |
| the readings that met `until` | `readings`, the shape above, present when `reason` is `condition_met`: a read made after the stop differs from them by the sensor's noise | `drive` `turn` `arc` `command_device` |
| what a drivetrain move measured | `measured: {distance_cm, heading_change_deg, source, left_deg, right_deg, heading_error?}`; `source` is `gyro` (the drivetrain's `heading` channel, §3) or `encoders`; `heading_error` says why a declared heading did not measure the move (§3) | `drive` `turn` `arc` |
| how long the call took | `ms` | `read_all` `wait_until` `drive` `turn` `arc` `command_device` `run_program` |
| why a call ended | `reason` | `wait_until` (`condition_met`, `timeout`, `preempted`) and every command result (`StopReason`) |
| a loop's report | `LoopReport` (§5a); `reason` is why the loop ended (`LoopEndReason`) | `run_loop` `supervise_loop` |

**`reason` of a command result.** `completed`: the whole request was done; `clamped` may be true beside it when an argument that is not the target was cut. `clamped`: the target was cut to a limit and the shorter target was reached. `condition_met`: `until` ended it. `stalled`, `preempted`, `timeout`: it ended early, and `measured` says how far it got. A caller tests `reason`, never `clamped`, to know whether a move did what was asked.

**`next` after an error.** An error whose fix is another tool names that tool first: a condition on a channel that is not active names `read_device`, then the same tool. Otherwise a retryable error and `invalid_argument` name the same tool first. `busy` then names `read_all` and `stop`: the call in flight ends by itself, and `stop` ends it early; a robot that is `looping` names `supervise_loop` and `stop`. The end of a loop is data (`reason`), never an error: `invalid_argument` covers a rate above the executor's maximum and a loop spec that fails validation (the message names the field); `unsupported` covers a robot with no loop executor, a device mix no executor covers, and an output command without `drives`; `busy` covers a second loop and a moving call during a loop; `illegal_state` is `supervise_loop` on a robot that has run no loop on this link. `illegal_state` names `read_all`: the robot is not in `fault` and takes every other tool. `unsupported` from `drive`, `turn` or `arc` names `describe_robot`, then `command_device`: the robot's actuators are its devices. A moving call that failed after it started names `read_all` first (§1).

| code | retryable | meaning |
|---|---|---|
| unknown_robot / unknown_device / unknown_channel / unknown_command | no | name not found; message lists valid ones |
| unsupported | no | drive, turn or arc on a robot without a drivetrain, or whose drivetrain's pair device is not attached; a command the brick's hardware cannot do |
| invalid_argument | no | names field, schema rule, allowed range |
| robot_offline | yes · while the process shuts down: no | the robot's link is `offline` or closed during the call (§1). A call to a robot that is already `offline` carries `connect` in its message; a call the link closed under carries the driver's reason |
| busy | yes | activity is acting/running_program/looping/stopping; `retry_after_ms` |
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
| loops | `run_loop` `supervise_loop` |

`run_loop` and `supervise_loop` are not program calls: a program is a sequence in the server's process, a loop is a law on an executor.

- `list_robots` returns the robots of the process: `{robots: [{id, backend, link, activity, fault_reason, connect}]}`; `connect` tells what a person must do to bring an offline robot online. It is the one tool that addresses no robot, so its envelope has no `robot`.
- Every other tool takes `robot_id` and runs under the state of §1; the runtime executes it (§4).
- `request_id` is optional on the tools that take it and is a label (§0.5).
- A tool that moves the robot is annotated `idempotentHint: false`.
- Defaults are stated in the description of their argument: `speed_pct` 30, `rate_hz` 10 (`sample_device`), `poll_hz` 20 (`wait_until`), `direction` forward (`arc`).
- `read_device` without `channels` reads the device's active non-image channels; an image channel or one that needs a mode switch is read only when named (§2.2).
