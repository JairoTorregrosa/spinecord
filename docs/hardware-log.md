# Hardware log

Runs on real robots. Newest first.

## 2026-11-21 · EV3 on ev3dev-stretch · driver-ev3dev over SSH (~600 ms round trip)

Robot: motors B, C (`lego-ev3-l-motor`), IR on S4, battery 8.06 V, Python 3.5.3.

| Test                                                       | Result                                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| read-only smoke (install bridge, hello, read every device) | ✓ device ids identical to `driver-ev3`                                                             |
| `ev3.B run_degrees 90 @20`                                 | ✓ 47° in the 250 ms bound, `time_limited`                                                          |
| `ev3.pair run_pair 180/180 @25`                            | ✓ 59/60° in 250 ms, wheels within 1°                                                               |
| `ev3.pair brake{}`, `stop()`                               | ✓ verified speed 0                                                                                 |
| runtime `drive 5 cm @25`                                   | ✗ chunk 1 `+36/+37`, chunk 2 `-59/-54`: robot reversed after a coasting overshoot; ended `timeout` |

| speech: `espeak -v es-la` from the brick | ✓ a Spanish phrase |
| 15 cm square, `ev3dev2.MoveTank` directly on the brick (not spinecord) | ✓ 4 sides × (307° straight, 193° turn), 9.0 s, encoder deltas exact |

| **square via spinecord runtime, after the latency fixes** (bridge ops up to 3 s, chunk to declared bound) | ✓ sides 15.0–15.5 cm, turns 90.5–92.9°, no reversal, all `completed`, 35.9 s (direct on brick: 9.0 s; the gap is ~0.6 s tunnel round trip per op) |
| square via spinecord runtime (drive 15 cm / turn 90° ×4) after driver+runtime fixes | ✗ every move ended `stalled: reversed` after 2 chunks; reversal detection worked and braked safely, 40.5 s total |

Cause: with ~600 ms round trip the wheels coast far past the next small absolute target before it is written, then `run-to-abs-pos` drives back. Coasting between chunks is only valid on low-latency links; ev3dev (on-brick watchdog) should run a whole side as one longer bounded operation.

Observed: positive motor degrees drive this robot **backward** → its profile needs `forward_sign: -1`.

Open: chained relative targets after coast (driver), chunk sizing and reversal detection (runtime), latency-aware chunk budget.
