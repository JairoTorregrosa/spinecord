# Hardware log

Runs on real robots. A row counts for the commit it names: a check passes for a revision when it ran on that revision.

## Status

| Path | On a real brick |
| --- | --- |
| Stock EV3 over USB through the bridge page (`apps/local --ev3`) | not run |
| EV3 on ev3dev, bridge version 4 (`apps/local --ev3dev`) | run on 2026-11-22: stop, `Esc`, the square, `kill -9` of the bridge, the guard (log below); direction by eye, `until`, the watchdog and brick off at start not yet |
| EV3 on ev3dev, a bridge before version 4 | run on 2026-11-21 (log below) |

Everything else about these paths is tested without a brick: the stock driver against the byte-level emulator (`packages/sim-ev3`), the ev3dev bridge against a fake sysfs tree with the local Python (`packages/driver-ev3dev/test`).

## To run

One pass per path (USB through the bridge page; ev3dev with bridge version 4). For each check add a row to the log with the date, the commit (`git rev-parse --short HEAD`), the robot and what was measured. Robot on the floor, a hand near it.

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
| brick off at start | start the server with the brick off, then turn it on | the server starts; the robot is `offline` with its hint, then `online` | n/a | ☐ |

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
