# Hardware log

Runs on real robots. A row counts for the commit it names: a check passes for a revision when it ran on that revision.

## Status

| Path | On a real brick |
| --- | --- |
| Stock EV3 over USB through the bridge page (`apps/local --ev3`) | not run |
| EV3 on ev3dev, bridge version 4 (`apps/local --ev3dev`) | not run |
| EV3 on ev3dev, bridge version 1 | run on 2026-11-21 (log below) |

Everything else about these paths is tested without a brick: the stock driver against the byte-level emulator (`packages/sim-ev3`), the ev3dev bridge against a fake sysfs tree with the local Python (`packages/driver-ev3dev/test`).

## To run

One pass per path (USB through the bridge page; ev3dev with bridge version 4). For each check add a row to the log with the date, the commit (`git rev-parse --short HEAD`), the robot and what was measured. Robot on the floor, a hand near it.

| Check | How | Passes when | USB | ev3dev |
| --- | --- | --- | --- | --- |
| direction | `drive` 5 cm at 25 % | the robot moves forward about 5 cm; backward means `profile.drivetrain.forward_sign` is `-1` for this robot | ☐ | ☐ |
| the square | `drive` 15 cm, `turn` 90°, four times | every move `completed`; sides and turns measured with a ruler; no wheel runs backward | ☐ | ☐ |
| `until` | `drive` 80 cm `until` distance < 15 cm, toward a wall | `condition_met`; the robot stands about 15 cm from the wall | ☐ | ☐ |
| stop | the `stop` tool during a 100 cm `drive` | `motors_stopped: true`, wheels at rest, the move answers `preempted` | ☐ | ☐ |
| `Esc` | `Esc` in Claude Code during a 100 cm `drive` | the robot stops; one `cancelled` line with `action: "stop"` on the server's stderr | ☐ | ☐ |
| closing the tab mid-move | close the bridge tab during a 100 cm `drive` | the robot stops within one operation (≤ 250 ms); `list_robots` shows `offline` with the `connect` hint | ☐ | n/a |
| pulling the cable mid-move | pull USB during a 100 cm `drive` | the same | ☐ | n/a |
| `kill -9` of the bridge | during a 100 cm `drive`: `ssh robot@<host> "pkill -9 -f ev3dev_bridge.py"` | the guard brakes both motors; the robot is `offline`, then `online` by itself | n/a | ☐ |
| the guard | with the robot online: `ssh robot@<host> "pgrep -af 'python3 -S'"`, then `kill` the process it lists | the guard is listed (the provider refuses a bridge without one); after the kill the bridge brakes every motor and ends, the robot is `offline`, then `online` with a new guard | n/a | ☐ |
| watchdog | during a 100 cm `drive`: take the brick off the network | both motors brake about 1 s after the last message | n/a | ☐ |
| brick off at start | start the server with the brick off, then turn it on | the server starts; the robot is `offline` with its hint, then `online` | n/a | ☐ |

## Log

Newest first.

### 2026-11-21 · EV3 on ev3dev-stretch · driver-ev3dev over SSH, about 600 ms round trip

Commit: `335ea3c` or a working tree shortly before it; the revision of each run was not recorded. Bridge version 1 (no guard process, no `read_many`).

Robot: motors B, C (`lego-ev3-l-motor`), IR on S4, battery 8.06 V. The brick's Python is 3.5.3; bridge version 1 ran on it.

| Check | Result |
| --- | --- |
| read-only smoke (install bridge, hello, read every device) | ✓ device ids identical to `driver-ev3` |
| `ev3.B run_degrees 90 @20` | ✓ 47° in the 250 ms bound, `time_limited` |
| `ev3.pair run_pair 180/180 @25` | ✓ 59/60° in 250 ms, wheels within 1° |
| `ev3.pair brake{}`, `stop()` | ✓ verified speed 0 |
| speech: `espeak -v es-la` from the brick | ✓ a Spanish phrase |
| 15 cm square, `ev3dev2.MoveTank` directly on the brick (not spinecord) | ✓ 4 sides × (307° straight, 193° turn), 9.0 s, encoder deltas exact |
| runtime `drive 5 cm @25`, 250 ms chunks that coast | ✗ chunk 1 `+36/+37`, chunk 2 `-59/-54`: the robot reversed after a coasting overshoot; ended `timeout` |
| square via the runtime (drive 15 cm / turn 90° ×4), 250 ms chunks that coast, reversal detection on | ✗ every move ended `stalled: reversed` after 2 chunks; the detection braked safely, 40.5 s total |
| square via the runtime (drive 15 cm / turn 90° ×4), one bridge operation per side (bound 3 s, the runtime chunks to the declared bound) | ✓ sides 15.0–15.5 cm, turns 90.5–92.9°, no reversal, all `completed`, 35.9 s (direct on brick: 9.0 s; the gap is about 0.6 s tunnel round trip per operation) |

Cause of the reversals: with about 600 ms round trip the wheels coast far past the next small absolute target by the time it is written, then `run-to-abs-pos` drives back. Coasting between chunks is only valid on low-latency links; on ev3dev (on-brick watchdog) a whole side runs as one longer bounded operation.

Observed: positive motor degrees drive this robot **backward**: its profile needs `forward_sign: -1`.
