# Hardware log

Runs on real robots. A row counts for the commit it names: a check passes for a revision when it ran on that revision.

## Status

| Path | On a real brick |
| --- | --- |
| Stock EV3 over USB through the bridge page (`apps/local --ev3`) | not run |
| Loops on the stock path (`run_loop` through the bridge page, host executor) | not run: the declared `max_rate_hz` of 50 is a conservative figure, not a measurement; the tick round trip over real USB, and whether a refreshed timed command runs smoothly on the firmware, are unmeasured |
| Sensors from discovery on the stock path: an NXT sensor (type 2 light), a type without an entry, the infrared channel | not run: the firmware's GET_FORMAT, GET_FIGURES, GET_SYMBOL and GET_MODENAME answers are taken from the lms2012 sources and tested against the emulator only |
| EV3 on ev3dev, bridge version 7 (`apps/local --ev3dev`): version 6 plus loops on the brick (`loop_start`, `loop_set`, `loop_probe`), the `power` command, `drives` and the guard's deadman | not run |
| Loops on ev3dev (`run_loop` on the bridge, device executor) **[hw]** | not run: the declared `max_rate_hz` of 50 is a starting figure; the tick's cost on the brick's Python 3.5 (`loop_probe`), C2 on a floor line, and the guard's deadman under `kill -STOP` are tested against a fake sysfs tree only |
| EV3 on ev3dev, bridge version 6: version 5 plus NXT sensors, generic sensors from sysfs and `hardware.ir_channel` | not run |
| EV3 on ev3dev, bridge version 5: version 4 plus a hello that may leave out `pair` | not run |
| EV3 on ev3dev, bridge version 4 | run on 2026-11-22: stop, `Esc`, the square, `kill -9` of the bridge, the guard (log below); direction by eye, `until`, the watchdog and brick off at start not yet |
| EV3 on ev3dev, a bridge before version 4 | run on 2026-11-21 (log below) |
| A phone as peripheral page over `--lan` (iPhone and Android, each as hotspot) **[hw]** | not run: the TLS listener, the token, the QR code and the certificate of local-ip.sh are tested with a fake page client and a test certificate; a real phone's resolver, its trust in the certificate and its camera, microphone and speech over that listener are unverified |
| A phone's own kinds and its sleep: imu, vibrator, torch, the wake lock, a locked screen **[hw]** | not run: tested against a fake browser (`apps/peripheral-page/test`), through the hub with a page whose socket is frozen (`apps/local/test/peripheral-page.test.ts`), and in Chrome with its sensors overridden (`apps/local/bench/results/phone-page.json`); the signs of tilt and heading on a real phone, its torch, its vibration, and what iOS and Android do to a page, its tracks and its wake lock when the screen locks are unverified |
| Tilt-steering a robot with a phone (a page's imu as a loop input, C5 of `docs/loops.md`) **[hw]** | not run: page channels as loop inputs are tested on the twin with a fake page client; a phone's real push rate of `deviceorientation`, its roll sign as held, and how fast a locked screen silences it are unmeasured |

Everything else about these paths is tested without a brick (and without a phone): the stock driver against the byte-level emulator (`packages/sim-ev3`), the ev3dev bridge against a fake sysfs tree with the local Python (`packages/driver-ev3dev/test`).

## To run

One pass per path (USB through the bridge page; ev3dev with the bridge in this repository, version 7; a tick carries the date it ran and the log names the commit). For each check add a row to the log with the date, the commit (`git rev-parse --short HEAD`), the robot and what was measured. Robot on the floor, a hand near it.

| Check | How | Passes when | USB | ev3dev |
| --- | --- | --- | --- | --- |
| direction | `drive` 5 cm at 25 % | the robot moves forward about 5 cm; backward means `profile.drivetrain.forward_sign` is `-1` for this robot | ☐ | ☐ |
| the square | `drive` 15 cm, `turn` 90°, four times | every move `completed`; sides and turns measured with a ruler; no wheel runs backward | ☐ | ☑ 2026-11-22 |
| `until` | `drive` 80 cm `until` distance < 15 cm, toward a wall | `condition_met`; the robot stands about 15 cm from the wall | ☐ | ☐ |
| stop | the `stop` tool during a 100 cm `drive` | `motors_stopped: true`, wheels at rest, the move answers `preempted` | ☐ | ☑ 2026-11-22 |
| `Esc` | `Esc` in Claude Code during a 100 cm `drive` | the robot stops; one `cancelled` line with `action: "stop"` on the server's stderr | ☐ | ☑ 2026-11-22 |
| closing the tab mid-move | close the bridge tab during a 100 cm `drive` | the robot stops within one operation (≤ 250 ms); `list_robots` shows `offline` with the `connect` hint | ☐ | n/a |
| pulling the cable mid-move | pull USB during a 100 cm `drive` | the same | ☐ | n/a |
| `kill -9` of the bridge | during a 100 cm `drive`: `ssh robot@<host> "pkill -9 -f ev3dev_bridge.py"` | the guard brakes both motors; the robot is `offline`, then `online` by itself | n/a | ☑ 2026-11-22 |
| the guard | with the robot online: `ssh robot@<host> "pgrep -af 'python3 -S'"`, then `kill` the process it lists | the guard is listed (the provider refuses a bridge without one); after the kill the bridge brakes every motor and ends, the robot is `offline`, then `online` with a new guard | n/a | ☑ 2026-11-22 |
| watchdog | during a 100 cm `drive`: take the brick off the network | both motors brake about 1 s after the last message | n/a | ☐ |
| a robot without a pair | start with `deployments/example/robots/arm.json` on a brick with motors on B and C; `describe_robot`, then `command_device` `run_degrees` on each | two `motor` devices and no `motor_pair`; `drivetrain: null`; `drive` answers `unsupported`; each motor turns by itself | ☐ | ☐ |
| loop rate | `run_loop` C4 on a free motor at 50 Hz for 10 s; time each tick's round trip | the report's `overruns` is 0 and `period_ms.p95` stays under 20 ms; the declared 50 Hz holds | ☐ | n/a |
| `loop_probe` **[hw]** | `probeLoop()` on the provider (from code, the robot idle and on blocks), once with its default plan and once with C2's plan; write down `mean_ms`, `p50_ms`, `p99_ms`, `max_ms`, `max_rate_hz` and `python` | it answers; no motor turns; `describe_robot` then shows the probed `max_rate_hz`; the numbers go in the log | n/a | ☐ |
| C2 on a floor line **[hw]** | a dark line on a light floor, color sensor on S3, touch on S1; `run_loop` C2 as printed (at the probed rate if it is under 50), `supervise_loop` with `wait_ms`, then `params: {speed: 15}` | `runs_on: "device"`; the robot follows the line; `overruns` 0; the bumper guard ends it with `guard`; `stop` ends it with `preempted` and both wheels at 0 | n/a | ☐ |
| `kill -9` of the bridge mid-loop **[hw]** | during C4 on a free motor (`power`): `ssh robot@<host> "pkill -9 -f ev3dev_bridge.py"` | the guard brakes the motor; the robot is `offline`, then `online` by itself | n/a | ☐ |
| `kill -STOP` of the bridge mid-loop **[hw]** | during C4: `ssh robot@<host> "pkill -STOP -f ev3dev_bridge.py"`, then `pkill -CONT` within 0.5 s | the motor brakes within 300 ms of the stop; after the `CONT` the loop ends with `overrun` and the motor stays braked | n/a | ☐ |
| a loop's cable | pull USB during `run_loop` | the motors end within `hold_ms` (60 ms at 50 Hz); `list_robots` shows `offline` | ☐ | n/a |
| brick off at start | start the server with the brick off, then turn it on | the server starts; the robot is `offline` with its hint, then `online` | n/a | ☐ |
| an NXT sensor | plug an NXT light sensor (USB) or an NXT ultrasonic sensor (ev3dev); `describe_robot`, then `read_device` on its port | kind `light` (USB) or `ultrasonic` (ev3dev); the reading follows a hand in front of it | ☐ | ☐ |
| a sensor without an entry | plug a sensor neither driver has an entry for (an NXT color sensor on USB, a HiTechnic one on ev3dev); `describe_device`, `read_device`, `command_device` `set_mode` | kind `sensor`; `values` has the length and unit the brick reports and follows the sensor; after `set_mode` the next `describe_device` shows the new length | ☐ | ☐ |
| a phone over `--lan` **[hw]** | two runs, one per phone: an iPhone, then an Android phone, each sharing its own hotspot with the computer joined to it. `--twin --pages --lan`; scan the QR code of `http://127.0.0.1:8768/console` with the phone's camera, open the link in Safari or Chrome; lend the camera and the microphone; `read_device` a frame; `command_device` `speak` "hola, ¿cómo estás?"; `listen` with `expect: ["buenos días"]` while a person says "buenos días" | the page joins (`describe_robot` lists it `active`); the frame is a picture of the room; the phone says the phrase in Spanish; `listen` answers `match: "buenos días"`. Write one row per phone: OS and browser version, whether the name resolved on the hotspot (the console's name check and the phone), where recognition ran, the Spanish voices listed | iPhone ☐ | Android ☐ |
| lock mid-`listen` **[hw]** | per phone (iPhone with Safari, Android with Chrome), over `--lan`: `listen` with `max_ms: 15000`, lock the screen 2 s in; unlock after 10 s and keep the page in front | the `listen` answers `device_offline` (or `timeout`) within its bound + 2 s; `describe_robot` shows the page `asleep` within 4 s of the lock and `active` after the unlock; a `read_device` of a frame and a second `listen` work without a new tap; write whether the camera and microphone tracks were muted or ended, and whether the list says the screen is kept on again | iPhone ☐ | Android ☐ |
| lock mid-watch **[hw]** | per phone: `wait_until` on `phone.touch` `b1` eq true with `timeout_ms: 20000`, lock the screen 2 s in | the watch ends with `condition_unreadable` within about 1 s of the lock, its message naming the page; after the unlock a new `wait_until` is met by a press | iPhone ☐ | Android ☐ |
| torch **[hw]** | per phone: `command_device` `phone.camera` `configure{facing: "environment"}`, then `describe_robot`; if `phone.torch` is listed, `set{on: true, ms: 3000}` | the torch is listed or its `unavailable` reason says why; write whether it was listed at join or only after the `configure`; listed, the light goes on and goes off by itself after 3 s; write which (OS and browser version) | iPhone ☐ | Android ☐ |
| tilt-read **[hw]** | per phone: allow the motion sensors in the tap; read `phone.imu` lying flat, then with the top edge raised about 45°, then the right edge lowered about 45°, then turned a quarter turn to the left | flat: `pitch_deg` and `roll_deg` near 0, `accel_z_m_s2` near +9.8; top raised: `pitch_deg` near +45; right lowered: `roll_deg` near +45; a quarter turn left: `heading_deg` up by about 90 where it is not absent. A sign that is the other way is a bug to fix in `apps/peripheral-page/src/devices/imu.ts` | iPhone ☐ | Android ☐ |
| tilt-steer a real robot **[hw]** | `--ev3 --pages --lan`, one phone on its hotspot joins as `phone` and lends its motion sensor; `run_loop` C5 with `duration_ms: 20000`, the robot on the floor; hold the phone flat, roll it 20° each way, lower its top edge 20°, press button 1; start again and lock its screen | flat: both wheels at rest; a roll: the wheels turn apart, the robot toward the lower side (else the signs of `k_left` and `k_right` are swapped for this grip); the top edge down: the robot drives forward; button 1: the loop ends with guard `stop_button`; the locked screen: the loop ends `input_lost` within about 0.5 s and both wheels brake. Write the phone, its browser, the report's `period_ms` and the trace's spacing of distinct `roll` values (the push rate) | ☐ | n/a |
| an infrared remote on channel 2 | `hardware.ir_channel: 2` in the robot file, the remote's switch on 2; `read_device` `remote_buttons` with `allow_mode_switch` while a button is held | the button's code; with the switch on 1 the reading is 0 | ☐ | ☐ |

## Log

Newest first. Commit = the revision of this repository that ran.

| Date | Commit | Robot and link | Check | Result |
| --- | --- | --- | --- | --- |
| 2026-11-22 | 4059118 ⁴ | R ³ | the guard: `kill` of the guard process, robot idle | ✓ the bridge braked every motor and ended (exit 3, "the guard process ended (exit -15)"); `offline`, then `online` by itself with a new guard |
| 2026-11-22 | 4059118 ⁴ | R ³ | `kill -9` of the bridge 0.8 s into a 40 cm `drive` at 30 % | ✓ both motors at speed 0 0.6 s after the kill (guard); the drive answered `robot_offline` after 2.4 s; `offline`, then `online` by itself |
| 2026-11-22 | 4059118 | R ³ | connect, one server | ✓ `online` 27 s after the server started, `idle` |
| 2026-11-22 | 4059118 ⁴ | R ³ | the stops at connection, timed | the first missed its 1.5 s bound (`no reply to stop within 1500 ms`), the second was verified in 846 ms |
| 2026-11-22 | 4059118 | R ³ | start of the bridge, `python3 -u` on the file against `import` with `__pycache__` | 9.2–12.7 s against 6.8 s on the brick; with a busy brick a bare `python3 -c pass` took 40.8 s |
| 2026-11-22 | a0c67c9 | R ³ | connect | ✗ every hello past 20 s while another process started bridges in a loop (load 7, swap in use); with one server ✓ `online` after 24–28 s, in `fault`: the stop at connection missed its 1.5 s bound (the next stops took 95–190 ms) |
| 2026-11-22 | a0c67c9 | R ³ | the `stop` tool from a Code Mode script 1.5 s into a 100 cm `drive` at 30 % | ✓ `motors_stopped: true` in 497 ms; the drive answered `preempted` after 18.3 cm |
| 2026-11-22 | a0c67c9 | R ³ | `Esc` in Claude Code (interactive, Code Mode on) 1.5 s into a 100 cm `drive` at 30 % | ✓ `cancelled` with `action: "stop"`, `stop verified`, the drive answered `preempted` after 2.3 s |
| 2026-11-22 | a0c67c9 | R ³ | the square, plain tool calls (`drive` 15 cm @30, `turn` 90° left, ×4) | ✓ every move `completed`; encoder sides 15.7–16.1 cm, turns 91.5–99.6° (the square closes 13.8° over 360°), 43 s for the turn of the model |
| 2026-11-22 | a0c67c9 | R ³ | `drive` 5 cm @25 | ✓ `completed`, encoders −115/−122° (102° is 5 cm); direction not checked by eye |
| 2026-11-21 | not recorded ¹ | R ² | read-only smoke (install bridge, hello, read every device) | ✓ device ids identical to `driver-ev3` |
| 2026-11-21 | not recorded ¹ | R ² | `ev3.B run_degrees 90 @20` | ✓ 47° in the 250 ms bound, `time_limited` |
| 2026-11-21 | not recorded ¹ | R ² | `ev3.pair run_pair 180/180 @25` | ✓ 59/60° in 250 ms, wheels within 1° |
| 2026-11-21 | not recorded ¹ | R ² | `ev3.pair brake{}`, `stop()` | ✓ verified speed 0 |
| 2026-11-21 | not recorded ¹ | R ² | speech: `espeak -v es-la` from the brick | ✓ a Spanish phrase |
| 2026-11-21 | not recorded ¹ | R ² | 15 cm square, `ev3dev2.MoveTank` directly on the brick (not spinecord) | ✓ 4 sides × (307° straight, 193° turn), 9.0 s, encoder deltas exact |
| 2026-11-21 | not recorded ¹ | R ² | runtime `drive 5 cm @25`, 250 ms chunks that coast | ✗ chunk 1 `+36/+37`, chunk 2 `-59/-54`: the robot reversed after a coasting overshoot; ended `timeout` |
| 2026-11-21 | not recorded ¹ | R ² | square via the runtime (drive 15 cm / turn 90° ×4), 250 ms chunks that coast, reversal detection on | ✗ every move ended `stalled: reversed` after 2 chunks; the detection braked safely, 40.5 s total |
| 2026-11-21 | not recorded ¹ | R ² | square via the runtime (drive 15 cm / turn 90° ×4), one bridge operation per side (bound 3 s, the runtime chunks to the declared bound) | ✓ sides 15.0–15.5 cm, turns 90.5–92.9°, no reversal, all `completed`, 35.9 s (direct on brick: 9.0 s; the gap is about 0.6 s tunnel round trip per operation) |

¹ The revision of these runs was not recorded. Their results were first committed in `335ea3c`, where the bridge is version 1 (no guard process, no `read_many`).

⁴ The launch by import and the 60 s hello of 4059118, with two stops at connection instead of three; the timed run also logged each stop's duration.

³ R on 2026-11-22: battery 8.27 V, IR on S4 in `IR-PROX`, 56 MB of RAM with three of the owner's Python programs started at boot; on a phone's Wi-Fi hotspot, ping 21–149 ms; `forward_sign` −1 in its robot file. Server and Claude Code (Fable 5.2) on macOS.

² R: an EV3 on ev3dev-stretch, motors B and C (`lego-ev3-l-motor`), IR on S4, battery 8.06 V, the brick's Python 3.5.3; driver-ev3dev over SSH, about 600 ms round trip.

Notes on the 2026-11-21 runs:

- Cause of the reversals: with about 600 ms round trip the wheels coast far past the next small absolute target by the time it is written, then `run-to-abs-pos` drives back. Coasting between chunks is only valid on low-latency links; on ev3dev (on-brick watchdog) a whole side runs as one longer bounded operation.
- Positive motor degrees drive this robot **backward**: its profile needs `forward_sign: -1`.
