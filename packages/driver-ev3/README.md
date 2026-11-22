# @spinecord/driver-ev3

EV3 direct commands over any byte transport, and `Ev3Provider`, the contract `Provider` for a stock-firmware LEGO EV3. Owns the EV3 protocol only: no kinematics, no conditions, no networking.

| File           | What it is                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `encode.ts`    | Pure encoders and decoders for direct commands. No I/O.                                                                  |
| `transport.ts` | `Transport { send(bytes): Promise<Uint8Array> }` and `WebHIDTransport` (VID 0x0694, PID 0x0005).                         |
| `link.ts`      | `Ev3Link`: one command at a time, always with reply, matched by counter, timeout rejects; urgent lane and hold for stop. |
| `provider.ts`  | `Ev3Provider implements Provider`: ports to DeviceSpecs, reads, bounded commands, verified stop.                         |
| `robot-file.ts` | `RobotFile {pair, hardware, profile}` and `parseRobotFile`: the robot file of a deployment, validated once for every app. |
| `fake.ts`      | `FakeEV3`: a kinematic fake brick for unit tests (no physics).                                                           |

Tests: `bun test` in this folder. Typecheck: `bunx tsc --noEmit -p .`

## Using the provider

```ts
import { Ev3Provider, WebHIDTransport } from "@spinecord/driver-ev3";

const transport = await WebHIDTransport.request(); // needs a user gesture in Chrome
const ev3 = new Ev3Provider(transport, {
  limits: profile.limits, // required: max_speed_pct, max_command_ms
  hardware: robot.hardware, // required: see below (robot = parseRobotFile(json), robot-file.ts)
  pair: { left: "B", right: "C" }, // optional, this is the default
  roles: profile.roles, // optional, role -> device id
});
const devices = await ev3.devices(); // detects what is plugged in
await ev3.command("ev3.pair", "run_pair", { left_deg: 90, right_deg: 90, speed_pct: 30, brake: false }, signal);
await ev3.command("ev3.pair", "brake", {}, signal);
```

Config is required; a missing or invalid field throws `RuntimeError("misconfigured")` at construction.

| Field                      | Meaning                                                                           |
| -------------------------- | --------------------------------------------------------------------------------- |
| `limits.max_speed_pct`     | From the robot profile. Higher speeds are cut and reported as clamped.            |
| `limits.max_command_ms`    | From the robot profile. The motion bound is `min(250, max_command_ms)`.           |
| `hardware.low_battery_v`   | `battery.low` is true under this voltage.                                         |
| `hardware.max_tone_ms`     | Longest speaker tone (1..32767); longer requests are cut and reported as clamped. |
| `hardware.tone_volume_pct` | Speaker volume for `tone` and `beep` (1..100).                                    |

`EXAMPLE_EV3_HARDWARE` (6.5 V, 5000 ms, 50 %) is an example for a stock brick. It is not applied unless you pass it.

Optional: `id` (default `ev3`), `degPerSecAt100` (calibration: motor speed at 100 % in deg/s, default 1050 for a large motor), `timeoutMs` (reply timeout, default 300), `modeSwitchTimeoutMs` (default 1000), `stopSettleMs` (default 300), `pollMs` (default 10: the shortest pause between two questions to the brick), `now` and `sleep` (a clock; pass both when it does not run at real speed).

### Behaviour

- **Devices.** `ev3.A`..`ev3.D` for detected motors, `ev3.pair` when both pair ports have motors, `ev3.S1`..`ev3.S4` for touch (type 16), color (29), ultrasonic (30), gyro (32), infrared (33), plus `ev3.speaker`, `ev3.display`, `ev3.led`, `ev3.buttons`, `ev3.battery`. The speaker has `tone` and `beep` only: the stock firmware has no text-to-speech, so it does not declare `speak` (CONTRACT §2.3; `driver-ev3dev` does when the brick has `espeak`). Anything else that is plugged in appears as a device of kind `unknown` with its EV3 type id in the description and no channels or commands. `devices()` only reads; call it again after plugging or unplugging something.
- **Signs.** Angles follow the contract: counter-clockwise-positive seen from above. The EV3 gyro is clockwise-positive natively, so `angle_deg` and `rate_deg_s` are negated here; the infrared sensor's `beacon_heading` is negative to the left natively and is negated too. Motor `position_deg`, `left_deg`, `right_deg` and the degrees in commands are shaft rotation in the motor's own forward direction (positive speed in the firmware); they are not headings and are passed through unchanged.
- **Reads have no side effects.** One `Reading` per channel; a channel that cannot be read has `value: null` and `error`. Every sensor channel carries `mode_group` (its port, e.g. `S3`) and `active` (its mode is the sensor's current mode). A read returns the active channels and gives the others `error: "mode_switch_required"`. The mode is switched only when the channel is named in `channels` and `opts.allow_mode_switch` is true. Each read re-checks the sensor's type and mode in the same exchange, so a mode changed from outside is noticed instead of misread.
- **Round trips.** A packet costs a round trip (about 2 ms over USB HID), so the provider sends few. Reads issued in the same turn, such as one read of every device, travel as one direct command: `Ev3Link.read(build, globals)` takes a builder `(base) => bytecodes` and places each read's reply at its own offset of the global buffer, splitting only at the firmware's limits (1019 reply bytes, 1024 bytes per message). If the brick rejects a shared command, each read is sent again alone, so only the read at fault fails. Reads that switch a sensor mode, and every command, still travel alone and in order. A running operation is asked about when the answer can change something (`schedule.ts`): once right after the brick ends a time operation, and for a degree target at half the time it still needs until the encoder has shown the motor's real speed, then at 90 % of it, down to one question every `pollMs` near the target, which is where the early brake gets its precision. The start travels behind the tacho read it starts from, and the early stop ahead of the read of where it ended. An abort or `stop()` wakes a waiting operation at once. A preempted motion never begins: the start packet is built when it leaves the queue, and an operation aborted while it waited sends the tacho read alone and answers `preempted` with nothing measured; aborted once the start is on the wire, it is braked.
- **`onDevicesChanged(cb)`.** Called after a mode switch (the `active` flags changed) and when a read finds another device on a port.
- **One operation per command.** The provider never splits a command. Motion uses only time-bounded opcodes (AF, B1) of at most `min(250, max_command_ms)` ms, so a blocked motor ends at the time bound. `run_degrees`, `run_to_position` and `run_pair` take a degree target: the operation is sized from the calibration and braked early (A3) when the encoder reaches the target. If the target needs longer than the bound, the command ends with `reason: "timeout"` and `measured.time_limited: true`; the caller sends the rest. `run_time` over the bound is cut and reported as clamped.
- **`brake`.** Motion commands take `brake` (default true); false coasts at the end. `ev3.pair` `brake{}` brakes only the pair's motors and checks both read speed 0, or throws `stop_unverified`.
- **Results.** `measured` comes from the encoders. `reason` is `completed`, `clamped` (speed, time or tone was cut; `applied_*` in `measured`), `timeout` (degree target not reached at the time bound), `stalled` (an operation of at least 100 ms ended at the time bound having moved under 10 % of what its speed predicts) or `preempted` (AbortSignal or stop; the motors are braked).
- **Busy.** A second command on an output port that is running throws `busy`. Different ports can run at the same time.
- **Stop.** `stop()` preempts every running operation and sends A3 brake on all ports ahead of the queue. Everything queued is dropped, and other commands wait until the verdict. It then reads A8 speed on every output and A9, every `pollMs`, until all read 0, or returns `motors_stopped: false` after `stopSettleMs`.
- **`stop_worst_ms`.** Equals `max(timeoutMs, modeSwitchTimeoutMs) + timeoutMs + stopSettleMs + pollMs + timeoutMs`: one command already in flight, the brake, the settle window and the last check. With the defaults that is 1910 ms.
- **Errors.** Always `RuntimeError` with a contract code: lost reply → `timeout` (retryable), brick error reply or malformed reply → `internal`, transport failure → `robot_offline` (retryable), bad arguments → `invalid_argument`, plus `unknown_device`, `unknown_channel`, `unknown_command`, `busy`, `stop_unverified`, `misconfigured`.

### What is never sent

- System commands (types 0x01/0x81). `encode.ts` has no encoder for them; system command 0xA0 is the firmware update.
- No-reply commands (type 0x80), `OUTPUT_READY` (0xAA, blocks the brick), `OUTPUT_START` (0xA6, unbounded), degree-bounded motion (AC, AE, B0: a blocked wheel keeps them busy forever), and any time of 0 (means "forever" in the firmware).

## Writing a brick emulator (a `Transport`)

A simulated brick implements `Transport.send(packet)` and returns the reply bytes. Everything needed to decode packets and build replies is exported from `encode.ts`:

| Export                                                                                                              | Use                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decodeCommand(packet)`                                                                                             | `{ counter, type, globals, locals, bytecodes }`. `globals` is the number of reply bytes to reserve. Ignores trailing padding. For non-direct types, `bytecodes` is the raw payload.                 |
| `readParam(bytecodes, at)`                                                                                          | Reads one parameter: `{ param: {kind: "const" \| "string" \| "global", value}, next }`. Handles LC0, LC1, LC2, LC4, LCS, GV0, GV1, GV2. Throws `RangeError` on local variables and truncated input. |
| `encodeReply(counter, ok, globals)`                                                                                 | Builds `[len][counter][0x02 \| 0x04][globals]`.                                                                                                                                                     |
| `OP`, `SUB`                                                                                                         | Opcode and subcode numbers.                                                                                                                                                                         |
| `TYPE_DIRECT_REPLY`, `TYPE_DIRECT_NO_REPLY`, `TYPE_SYSTEM_REPLY`, `TYPE_SYSTEM_NO_REPLY`, `REPLY_OK`, `REPLY_ERROR` | Message type bytes.                                                                                                                                                                                 |
| `SENSOR_TYPE`, `TYPE_NONE`, `DEVICE_NAMES`, `OUTPUT_MASK`, `ALL_OUTPUTS`, `outputIndex`                             | Device type numbers and port helpers.                                                                                                                                                               |
| `readF32`, `readI32`, `readI8`, `toHex`, `fromHex`, `decodeReply`, `frame`                                          | For tests of the emulator.                                                                                                                                                                          |

`fake.ts` is a complete, small example: its `execute()` is the interpreter loop to copy.

What the provider expects from a brick, per opcode (layer is always 0):

| Bytes                                 | Parameters                                                      | Reply globals                                                            |
| ------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `A3` stop                             | mask, brake                                                     | —                                                                        |
| `A8` read                             | port index 0..3                                                 | speed int8 (−100..100, measured, 0 when the shaft is still), tacho int32 |
| `A9` test                             | mask                                                            | busy uint8 (1 if any motor in the mask is running a step/time command)   |
| `AF` time speed                       | mask, speed, ms1, ms2, ms3, brake                               | —                                                                        |
| `B1` time sync                        | mask (two motors), speed, turn −200..200, ms, brake             | —                                                                        |
| `B2` clear count                      | mask                                                            | —                                                                        |
| `B3` get count                        | port index                                                      | tacho int32                                                              |
| `99 05` type/mode                     | port 0..3 inputs, 16..19 outputs                                | type uint8, mode uint8 (126 = empty; 7 large motor, 8 medium)            |
| `99 1D` ready SI                      | port, type (0 = keep), mode (−1 = keep), count                  | `count` float32 (NaN when nothing is plugged in)                         |
| `94 01` tone                          | volume, hz, ms                                                  | —                                                                        |
| `84 13` / `84 11` / `84 05` / `84 00` | fill window / select font / text (color, x, y, string) / update | —                                                                        |
| `82 1B` led                           | pattern 0..9                                                    | —                                                                        |
| `83 09` button pressed                | button 1..6 (7 = any)                                           | uint8                                                                    |
| `81 01` / `81 12`                     | battery                                                         | float32 volts / uint8 percent                                            |

Rules an emulator must follow so it behaves like the firmware:

- One direct command may hold several opcodes; run them in order and write each result at its global offset.
- B1 (same rule as B0): the lower-numbered port runs at `speed`. `turn > 0` scales the higher port by `(100 − turn)/100` (so 100 stops it, 200 reverses it); `turn < 0` does the same to the lower port. Both motors run for `ms` and stop together (in B0, the full-speed motor travels `step` degrees and the other proportionally). Checked against the `opOUTPUT_STEP_SYNC` and `opOUTPUT_TIME_SYNC` handlers in lms2012 `d_pwm.c`: master = lower port for `turn > 0`, higher port for `turn < 0`.
- A motor is busy from the start of a step/time command until it reaches its bound or receives A3. A blocked motor stays busy in a step command, and ends on time in a time command.
- `99 1D` with type 0 and mode −1 must leave the sensor's type and mode unchanged; `99 05` reports the current mode. The provider relies on both for side-effect-free reads.
- After A3 a real shaft keeps reading a non-zero A8 speed for a few tens of ms; the provider waits for 0.
- The sensor modes the provider uses: touch 0 pressed, 1 bump count; color 0 reflected, 1 ambient, 2 color id, 4 raw RGB (3 values); ultrasonic 0 cm; gyro 0 angle, 1 rate (switching mode zeroes the angle; emulators report the native clockwise-positive values, the provider negates them); infrared 0 proximity, 1 seek (heading, distance per channel; the provider reads the first two values), 2 remote.
- Answer an opcode you do not implement with `encodeReply(counter, false)`; never invent a success.
- A real brick ignores a command that arrives while it is still handling the previous one.

## Not verified on hardware yet

Everything here is tested against `FakeEV3`, the LEGO Communication Developer Kit hex examples and golden bytes generated from OpenMindstorms (`fixtures/`, MIT). Still to confirm on a real brick: the B1 turn sign on a real base, how many degrees a motor overshoots a target between polls, how smooth chained coasting operations are, the 1050 deg/s constant, how long A8 takes to read 0 after a brake (`stopSettleMs`), that READY_SI with mode −1 keeps the mode, the gyro reset by mode switch, sensor mode-switch latency, and `WebHIDTransport` itself.
