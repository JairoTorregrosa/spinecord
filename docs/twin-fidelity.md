# Twin fidelity: the twin against a real EV3

`bun run twin-bench` (about 40 s, exit 0) runs the twin on the app's own path: tool call, then `LocalRobot`, then the runtime, then `Ev3Provider`, then `SimBrick`, then `World`. It sets each number next to what a real EV3 does. The real numbers and their sources are in `scripts/twin-bench/real.json`.

Each row has one of four verdicts:

- **ok**: the twin is inside the real band, widened by the row's tolerance.
- **OFF**: outside the band, where the band is a measurement, a LEGO spec, or a figure derived from the firmware.
- **SUSPECT**: outside a first-principles estimate. That is not a measurement, so check it on a robot.
- **MEASURE**: no real number exists yet.

Noise-off rows give identical output on every run; noise-on rows are seeded. The full table is at the end.

Two kinds of evidence carry caveats:

- The only real-robot runs (`docs/hardware-log.md`) used **ev3dev**, not stock firmware. They have their own speed regulator and a 21–600 ms link, so they show direction and size, not exact values.
- The workshop files cap speed at 60 %. The bench raises the cap to 100 to reach the 75 % and 100 % rows; those rows, and the gyro's 440 deg/s limit (r1 spins at about 285 deg/s at 60 %), matter only for a robot with a higher cap.

Each finding names its owner. **physics** is `packages/sim-ev3` and `packages/sim-world`, the twin's alone. **provider** is `packages/driver-ev3/provider.ts`, which a real robot runs too. **data** is a deployment file.

## What misleads someone who develops on the twin, worst first

1. **Turns on tracks are an assumption.** For orugas, by encoders, `turn 90` turns the body 72.2° and `turn 360` turns it 288.5°. That comes from `noise.turn_scrub` 0.2 (`deployments/orugas/worlds/sala.json:80`). The 0.2 was taken from a four-wheel Pioneer P3-AT on tiles (ICR 1.47, which would give 61°), not from an EV3 on treads. A program tuned on the twin, such as "turn 112 to get 90", is wrong by the difference.
   - Class: wrong constant, unmeasured. Owner: data.
   - Fix: run `turn 360` on the real orugas, measure the angle with a protractor or a line on the floor, and set `turn_scrub = 1 - true/360`.
2. **A stop is dead on the spot in the twin. Real robots overshoot.**
   - Twin: brake travel is 0° at every speed (`packages/sim-ev3/brick.ts:90-93`).
   - Real, ev3dev with the same motors and 5.6 cm wheels:
     - `drive 5` @25 overshoots 13–20° of wheel; the twin overshoots 0–3°.
     - Square sides read 15.7–16.1 cm by encoders; the twin reads 15.1.
     - Square turns read 91.5–99.6°; the twin reads 90.1–92.4.
   - First principles for stock firmware: `BrakeMotor` drives full reverse only 25 counts past the stop point, then returns. With the measured 76 ms time constant that is about 2–6° at 25 %, 7–15° at 50 % and 23–35° at 100 %.
   - Link jitter does not explain the ev3dev overshoot. With a seeded round trip of 2–10 ms or 21–149 ms per packet, the twin's `drive 5` still overshoots only 1°, its square sides read 15.0–15.3 and degree targets land within 1.6°. Moves end on operations the brick times itself, and the twin's motor turns at exactly the rate the provider predicts, so a late answer changes nothing. On a robot the rate varies with load and battery, so this is the twin's best case.
   - Where it shows: accumulated position error, in squares, in line-up moves, and at the end of `until`.
   - Class: missing effect. Owner: physics.
   - Fix: in `motorStep` brake, run the shaft on with a reverse-power deceleration (v0·τ − τ·vmax·ln(1+v0/vmax)), then spring back. Calibrate it on a real brake.
3. **Coast runs down about 6–9 times too fast.**
   - Twin: `COAST_MS_AT_100` is 200 ms (`brick.ts:42`), so 95° from 100 % and 24° from 50 %. Nothing backs that number; its comment says "to be calibrated".
   - First principles, from Philo's no-load current and stall figures and Things DAQ's inertia: 1.1–1.7 s and 550–860° from 100 %.
   - This matters because the runtime coasts between the 200 ms chunks of every move. On ev3dev the coast overshoot reversed the robot (`docs/hardware-log.md`, 2026-11-21).
   - Class: wrong constant, unmeasured. Owner: physics.
   - Fix: measure `run_time` 250 @100 with `brake:false` on a free motor and a loaded wheel, then set the constant from it.
4. **A wheel against a wall freezes in the twin. A real one probably spins.**
   - Twin: tacho 10°, speed 0, `stalled true`, reason `stalled` (`brick.ts:487-494`).
   - First principles: the motor's 0.4 N·m stall torque against a tyre's grip of about 0.07 N·m on a 0.7 kg base means the wheel slips. The encoder would keep counting, the regulator would hold speed, there would be no stall, and `drive` would report distance it never covered.
   - Class: wrong structure, unmeasured. Owner: physics.
   - Fix: measure `drive 20` into a wall. If it slips, model slip when the tyre's force limit is exceeded.
5. **The ultrasonic sensor is blind between its 9 rays.**
   - A 5 cm post inside the ±12° cone at 100–250 cm goes unseen at 171 of 300 positions. Example: at 150 cm, 3 cm off-axis reads 255 while 6 cm off-axis reads 150.2 (`world.ts:163-165`, `world.ts:964`).
   - A room corner seen at 45° reads 255. Two walls at 90° are a corner reflector, which echoes strongly.
   - Class: wrong structure. Owner: physics.
   - Fix: replace discrete rays with an angular integral (the nearest surface whose angular extent intersects the cone). Treat a concave corner (two hits within a few cm whose normals differ by about 90°) as an echo.
6. **Short commands start about 25 % slower than on a real motor.**
   - Twin, 250 ms after the start: `run_degrees 90 @20` reaches 36°, `run_pair @25` reaches 45°.
   - Real (ev3dev), same window: 47° and 59–60°, which is about 90 % of the full-speed distance.
   - Cause: the twin applies the open-loop 76 ms lag (Things DAQ, duty cycle, bare shaft) to *regulated* speed commands (`brick.ts:51`, `motorStep`). A speed regulator drives full power until the setpoint, so it rises faster.
   - Class: wrong structure. Owner: physics.
   - Fix: keep 76 ms for `power`. For speed commands, use a shorter effective constant (15–25 ms fits both rows, depending on whether 20 % means 201 or 210 deg/s) and confirm it on stock firmware.
7. **The provider reports a medium motor's speed about 35 % low, on the twin and on a real robot alike.**
   - At 50 %: true 780 deg/s on the twin and about 796 real, but `speed_deg_s` reads 510.
   - Cause: one `degPerSecAt100` for every motor (`packages/driver-ev3/provider.ts:901-903`, `:1295`, `:2010`).
   - The scales also disagree. The real default is 1050 (`provider.ts:674`); the firmware's own scale works out to 1007 for a large motor and 1591 for a medium one (lms2012 `d_pwm.c`, derived). The twin uses 1020.
   - Class: wrong constant. Owner: provider; it misleads on the real robot too.
   - Fix: a per-type scale chosen from the port's type (7 large, 8 medium). Set 1007 and 1591, or calibrate.
8. **Infrared ignores surface colour, and its range claims about 95 cm.**
   - A black surface at 38 cm reads 41 in the twin; on the stock firmware it reads 88–90 (issue 518).
   - The twin reads 100 only from 94 cm. LEGO and ev3dev say about 70 cm.
   - Orugas steers by this sensor, which sits about 20 cm above the floor; the 2D twin has no floor return.
   - Class: missing effect (albedo), plus a disputed constant. Owner: physics; the 95 cm in the provider's note is the provider's.
   - Fix: add a per-box albedo (default white) that scales the return. Measure the 70–100 cm part of the curve on a real sensor.
9. **The gyro never under-counts slow turns and exceeds its 440 deg/s range.**
   - Spinning at 100 % on r1, `rate_deg_s` reads 476. The real sensor saturates at 440 (`world.ts:562`, no clamp), and the angle would then fall behind. The workshop's 60 % cap keeps r1 near 285 deg/s, so it cannot happen there.
   - At 5 % the twin reads 358.9 for a 360° turn. One real sensor read 326–353, and its clockwise reading is 2 % short in general.
   - At rest, drift is 0 (`gyro_drift_deg_s` 0 by default).
   - Class: missing effect. Owner: physics. Fix: clamp the rate at ±440 and integrate the clamped rate.
   - The deadband and the asymmetry come from one unit: "the real robot varies; measure it".
10. **The colour sensor has no height, no room light and no in-between colours.**
    - Reflected light has no height dependence. The edge profile is 1.5 cm wide, set only by `color_spot_radius_cm`.
    - Ambient is a constant 5 (`brick.ts:655`).
    - Colour id is the floor exactly under the spot's centre: never the blue or green misread at an edge.
    - RGB is the floor's sRGB × 400/255, not sensor counts.
    - Class: missing effect. Owner: physics. Fix: measure on the workshop floor first.

## Suspicions that were disproved

- **Time.** A simulated second is a wall-clock second: the ratio over 15 s is 1.0000 at 50 Hz reads and 1.0000 at 1 Hz. Reading at 50 Hz moves a 60 cm noisy drive by 0.0004 cm. Watching changes nothing.
- **Large-motor speed scale.** 255, 510 and 765 deg/s at 25, 50 and 75 % are within 1.3 % of the firmware's derived 1007/100 %. Medium is −2 %.
- **Large motor at 100 %.** 1020 deg/s is inside the battery band (888–1020) but at its top: a real robot on 7.5 V is about 13 % slower. The medium motor at 100 % (1560) is above its band (1290–1500).
- **Open-loop lag.** `power` from rest reaches 63 % in 76 ms and 90 % in 175 ms, as Things DAQ measured.
- **Ultrasonic distance.** 5–250 cm square on reads exactly; 300 cm reads 255. Under 3 cm it clamps to 3. At 15° it still echoes; at 30°, 45° and 60° it reads 255, matching the ±25° measured by jamesjackson. Noise std is 0.31 cm, inside LEGO's ±1 cm.
- **Infrared.** A white wall at 38 cm reads 41 (real 40–41). Its noise std is 0.57 (real about 0.5, "always 40 or 41").
- **Gyro.** A 90° turn is off by 1.5° at the median and 3.5° at the 95th percentile against LEGO's ±3: the twin's gyro is marginally worse than spec. Counter-clockwise 360 reads 359.8 (real 359–363).
- **Battery and tone.** The battery reads 7.9 V (real robot R: 8.06–8.27). The tone call returns at once, as on the firmware.

## Sources that disagree

- **Infrared range.** LEGO ("up to 70 cm") and ev3dev ("100 % ≈ 70 cm") disagree with a linear extrapolation of the stock-firmware point (41 at 38 cm, which puts 100 at about 94 cm). The twin follows the extrapolation.
- **Large motor no-load speed.** LEGO says 160–170 rpm, Philo measured 175 rpm at 9 V, and the firmware's scale is 168 rpm per 100 %. ev3dev's 1050 deg/s (175 rpm) is Philo's 9 V figure, which a 7.4–8.3 V battery does not reach.
- **Ultrasonic angle.** One project measured ±25°; forum figures of 40–45° are unmeasured. The twin uses ±25.

## Measure these on a real robot first

1. Orugas turning 360° by encoders: the true angle gives `turn_scrub`.
2. A brake from 25/50/100 %: encoder travel past the stop, and the rest position.
3. A coast from 100 %: time and degrees, on a free motor and on a wheel.
4. `drive 20` into a wall: do the wheels slip, and what do `stalled` and the tachos say?
5. Stock-firmware step response of `run_time @20/50` over the first 250 ms.
6. IR proximity at 50, 70, 80 and 100 cm, against white and against the workshop's furniture.
7. Ultrasonic against a 5 cm post swept across the beam at 1–2 m, and into a room corner.
8. The workshop floor's reflected % on white and on the tape, at the real sensor height.
9. USB round trip of one direct command through the bridge page. The twin's is 0.1 ms in-process; a real one adds to every read and every host-decided stop.
10. Gyro at rest for 60 s, and after a reset while turning. The twin then drifts at −231 deg/s, its full turning rate, until a still reset (`world.ts:570`). Whether the real sensor does that is unknown.

## What the twin does not model

- Battery voltage: it does not sag, and speed and power do not depend on it.
- Load on a motor: robot mass, slope, friction against a wall.
- Wheel slip, except the seeded noise and `turn_scrub`.
- Backlash and brake spring-back.
- Sensor update periods: every read is a fresh value.
- Height or tilt of any sensor.
- Surface colour or material for the distance sensors.
- Floor return of a raised IR sensor.
- Multipath echoes, or a second ultrasonic sensor.
- Gyro saturation, deadband, temperature and bias drift (unless `noise.gyro_drift_deg_s` is set).
- Room light.
- The medium motor's own time constant: it uses the large motor's 76 ms.
- Gyro lag: the angle and rate follow the body in the same step.
- Link jitter: the app's twin talks to its brick through a microtask, so every answer is immediate. Only the bench's cable adds a round trip.
- Any spread in motor speed: a motor turns at exactly the commanded rate, which is why stops land exactly.

## Honesty of what the model is told (`packages/driver-ev3/provider.ts`)

- **`speed_deg_s` (`:899-904`).** It says "at 1020 deg/s per 100 %", which is wrong for medium motors by a factor of 1.56. The declared range of ±1020 (±1050 on a real robot) hides a medium motor's speeds above that.
- **Infrared `proximity_pct` (`:423`).** "100 means nothing in range (beyond about 95 cm)" is the twin's number; LEGO and ev3dev say about 70 cm. "Depends strongly on surface colour" is true of the robot and false of the twin. The declared noise of 3 is generous against a measured 0.5.
- **Ultrasonic `distance_cm` (`:367`).** "Angled surfaces read long": the twin reads 255 past 25°, and a real sensor reads either. "Soft surfaces" are not modelled. The declared noise of 2 is against LEGO's ±1 and the twin's 0.3.
- **Gyro `angle_deg` (`:388`).** "Drifts over time": the twin does not drift at rest. It drifts only after a reset while turning, and then by the whole turning rate. The `rate_deg_s` range of ±440 (`:400`) is exceeded by the twin.
- **Colour (`:316`, `:334`).** "Depends on distance and surface" and "unreliable beyond 2 cm" are true of the robot; the twin has neither effect.
- **`stalled` (`:910`).** "Ended because the motor could not turn" is honest for a held shaft. On a robot whose wheel slips against a wall it may never be true; see finding 4.

## Sources

- Philo, EV3 motor measurements: https://www.philohome.com/motors/motorcomp.htm
- LEGO EV3 User Guide (2013): https://www.ub.uzh.ch/dam/jcr:5ca1d1a6-aad5-479e-8946-d868d1c12ee2/ev3-user-guide-EN.pdf
- lms2012 motor driver: https://github.com/mindboards/ev3sources/blob/master/lms2012/d_pwm/Linuxmod_AM1808/d_pwm.c
- Things DAQ, EV3 large motor time constant: https://thingsdaq.org/2022/08/26/dc-motor-characterization-2-of-2/
- ev3dev sensor data: https://docs.ev3dev.org/projects/lego-linux-drivers/en/ev3dev-stretch/sensor_data.html
- EV3-G infrared proximity at 38 cm: https://github.com/ev3dev/ev3dev-lang-python/issues/518
- Ultrasonic within ±25°: https://github.com/jamesjackson/ev3-localization/blob/master/overview.md
- One gyro on a turntable: https://www.sites.google.com/site/ev3basic/ev3-basic-programming/using-sensors/gyro-sensor-accuracy
- TU Dresden robolab, motors and sensors: https://robolab.inf.tu-dresden.de/en/knowledge/hardware/motors
- Skid-steer ICR (P3-AT, not EV3): https://www.mdpi.com/1424-8220/15/5/9681
- Real runs of this repository (ev3dev): `docs/hardware-log.md`

<details>
<summary>The full table (output of <code>bun run twin-bench</code>; link and time rows use the real clock and vary by machine)</summary>

| group | quantity | real | source | twin | error | verdict | note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| motor | large motor, steady speed at 25 % (run_time) | 252 deg/s | derived: lms2012 | 255 | +1.2 % | ok |  |
| motor | large motor, steady speed at 50 % (run_time) | 504 deg/s | derived: lms2012 | 510 | +1.2 % | ok |  |
| honesty | large motor at 50 %: speed_deg_s the model reads | 504 deg/s | derived: lms2012 | 510 | +1.2 % | ok | true shaft speed 510 deg/s; the provider converts every motor's % with 1020 deg/s per 100 % (a real robot: 1050) |
| motor | large motor, steady speed at 75 % (run_time) | 755 deg/s | derived: lms2012 | 765 | +1.3 % | ok |  |
| motor | large motor, steady speed at 100 % (run_time) | 888..1020 deg/s | derived: philo | 1020 | +6.9 % | ok |  |
| motor | medium motor, steady speed at 25 % (run_time) | 398 deg/s | derived: lms2012 | 390 | -2 % | ok |  |
| motor | medium motor, steady speed at 50 % (run_time) | 796 deg/s | derived: lms2012 | 780 | -2 % | ok |  |
| honesty | medium motor at 50 %: speed_deg_s the model reads | 796 deg/s | derived: lms2012 | 510 | -35.9 % | OFF | true shaft speed 780 deg/s; the provider converts every motor's % with 1020 deg/s per 100 % (a real robot: 1050) |
| motor | medium motor, steady speed at 75 % (run_time) | 1193 deg/s | derived: lms2012 | 1170 | -1.9 % | ok |  |
| motor | medium motor, steady speed at 100 % (run_time) | 1290..1500 deg/s | derived: philo | 1560 | +11.8 % | OFF |  |
| motor | power 50 % from rest: time to 63 % of final speed | 76..98 ms | measured: thingsdaq | 76 | -12.6 % | ok |  |
| motor | power 50 % from rest: time to 90 % | 175..225 ms | derived: thingsdaq | 175 | -12.5 % | ok |  |
| motor | power 50 % (unregulated): final shaft speed, no load | 444..487 deg/s | estimate: philo | 491 | +5.5 % | ok | the twin runs power like a regulated speed: independent of battery and load |
| motor | speed 50 % from rest (regulated): time to 63 % | - | none: thingsdaq | 76 | - | MEASURE |  |
| motor | brake from 25 %: shaft travel after the stop | 2..6 deg | estimate: first_principles | 0 | -100 % | SUSPECT |  |
| motor | brake from 50 %: shaft travel after the stop | 7..15 deg | estimate: first_principles | 0 | -100 % | SUSPECT |  |
| motor | brake from 75 %: shaft travel after the stop | 14..25 deg | estimate: first_principles | 0 | -100 % | SUSPECT |  |
| motor | brake from 100 %: shaft travel after the stop | 23..35 deg | estimate: first_principles | 0 | -100 % | SUSPECT |  |
| motor | coast (provider, brake:false) from 50 %: travel after the end | 140..215 deg | estimate: first_principles | 24 | -86.5 % | SUSPECT |  |
| motor | coast (provider, brake:false) from 100 %: travel after the end | 550..860 deg | estimate: first_principles | 95 | -86.5 % | SUSPECT |  |
| motor | coast from 100 %: time to rest | 1100..1700 ms | estimate: first_principles | 193 | -86.2 % | SUSPECT |  |
| motor | run_degrees 90 @50, rtt 0 ms: final error | - | none: lms2012 | 0.8 | - | MEASURE | reported 91, last reason completed |
| motor | run_degrees 360 @50, rtt 0 ms: final error | - | none: lms2012 | 0.4 | - | MEASURE | reported 360, last reason completed |
| motor | run_degrees 360 @100, rtt 0 ms: final error | - | none: lms2012 | 1.6 | - | MEASURE | reported 362, last reason completed |
| motor | run_degrees 90 @50, rtt 6 ms: final error | - | none: lms2012 | 0.8 | - | MEASURE | reported 91, last reason completed |
| motor | run_degrees 360 @50, rtt 6 ms: final error | - | none: lms2012 | 0.4 | - | MEASURE | reported 360, last reason completed |
| motor | run_degrees 360 @100, rtt 6 ms: final error | - | none: lms2012 | 1.6 | - | MEASURE | reported 362, last reason completed |
| motor | run_degrees 90 @50, rtt 2-10 ms: final error | - | none: lms2012 | 0.8 | - | MEASURE | reported 91, last reason completed |
| motor | run_degrees 360 @50, rtt 2-10 ms: final error | - | none: lms2012 | 0.4 | - | MEASURE | reported 360, last reason completed |
| motor | run_degrees 360 @100, rtt 2-10 ms: final error | - | none: lms2012 | 1.6 | - | MEASURE | reported 362, last reason completed |
| motor | run_degrees 90 @50, rtt 21-149 ms: final error | - | none: lms2012 | 0.8 | - | MEASURE | reported 91, last reason completed |
| motor | run_degrees 360 @50, rtt 21-149 ms: final error | - | none: lms2012 | 0.4 | - | MEASURE | reported 360, last reason completed |
| motor | run_degrees 360 @100, rtt 21-149 ms: final error | - | none: lms2012 | 1.6 | - | MEASURE | reported 362, last reason completed |
| hw-log | ev3.B run_degrees 90 @20: degrees 250 ms after the start | 47 deg | measured: hwlog | 36 | -23.4 % | OFF | real is ev3dev: its own regulator, 1050 deg/s per 100 % |
| hw-log | ev3.pair run_pair 180/180 @25: degrees 250 ms after the start | 59..60 deg | measured: hwlog | 45 | -24.4 % | OFF | real is ev3dev: its own regulator, 1050 deg/s per 100 % |
| hw-log | drive 5 cm @25, rtt 0 ms: encoder degrees past the target | 13..20 deg | measured: hwlog | 3 | -81.8 % | OFF | encoders 105/105 for 102; coasting chunks (90 % of the time) |
| hw-log | square, rtt 0 ms: encoder side for 15 cm (max) | 15.7..16.1 cm | measured: hwlog | 15.1 | -5 % | OFF | sides 15.1, 15.1, 15.1, 15; coasting chunks (91 % of the time) |
| hw-log | square, rtt 0 ms: encoder turn for 90 (max) | 91.5..99.6 deg | measured: hwlog | 91 | -4.8 % | ok | turns 90.5, 90.5, 91, 91 |
| hw-log | drive 5 cm @25, rtt 6 ms: encoder degrees past the target | 13..20 deg | measured: hwlog | 0 | -100 % | OFF | encoders 102/102 for 102; coasting chunks (100 % of the time) |
| hw-log | square, rtt 6 ms: encoder side for 15 cm (max) | 15.7..16.1 cm | measured: hwlog | 15.1 | -5 % | OFF | sides 15.1, 15, 15.1, 15.1; coasting chunks (85 % of the time) |
| hw-log | square, rtt 6 ms: encoder turn for 90 (max) | 91.5..99.6 deg | measured: hwlog | 92.2 | -3.5 % | ok | turns 91, 91.2, 92.2, 91.2 |
| hw-log | drive 5 cm @25, rtt 50 ms: encoder degrees past the target | 13..20 deg | measured: hwlog | 0 | -100 % | OFF | encoders 102/102 for 102; every chunk braked |
| hw-log | square, rtt 50 ms: encoder side for 15 cm (max) | 15.7..16.1 cm | measured: hwlog | 15.1 | -5 % | OFF | sides 15.1, 15.1, 15, 15.1; every chunk braked |
| hw-log | square, rtt 50 ms: encoder turn for 90 (max) | 91.5..99.6 deg | measured: hwlog | 90.8 | -5 % | ok | turns 90.8, 90.1, 90.5, 90.1 |
| hw-log | drive 5 cm @25, rtt 2-10 ms: encoder degrees past the target | 13..20 deg | measured: hwlog | 1 | -93.9 % | OFF | encoders 103/103 for 102; coasting chunks (95 % of the time) |
| hw-log | square, rtt 2-10 ms: encoder side for 15 cm (max) | 15.7..16.1 cm | measured: hwlog | 15.3 | -3.8 % | OFF | sides 15.1, 15.1, 15.3, 15.1; coasting chunks (90 % of the time) |
| hw-log | square, rtt 2-10 ms: encoder turn for 90 (max) | 91.5..99.6 deg | measured: hwlog | 92.4 | -3.3 % | ok | turns 90.1, 90.5, 92.4, 90.5 |
| hw-log | drive 5 cm @25, rtt 21-149 ms: encoder degrees past the target | 13..20 deg | measured: hwlog | 1 | -93.9 % | OFF | encoders 103/103 for 102; every chunk braked |
| hw-log | square, rtt 21-149 ms: encoder side for 15 cm (max) | 15.7..16.1 cm | measured: hwlog | 15 | -5.7 % | OFF | sides 15, 15, 15, 15; every chunk braked |
| hw-log | square, rtt 21-149 ms: encoder turn for 90 (max) | 91.5..99.6 deg | measured: hwlog | 90.8 | -5 % | ok | turns 90.1, 90.1, 90.5, 90.8 |
| regulation | drive 20 cm @30 against a wall: encoders, speed, stall | - | estimate: first_principles | tacho 10 deg, speed 0, stalled true | - | SUSPECT | reason stalled; body moved 0.5 cm |
| drive | r1, rtt 0: drive 50 @50, true distance (cm) | - | none: hwlog | 50.11 | - | MEASURE | reported 50.1 cm by gyro, 2095 ms |
| drive | r1, rtt 0: turn 90 @30, true heading change (deg) | - | none: hwlog | 90.9 | - | MEASURE | reported 91 by gyro, 714 ms |
| drive | r1, rtt 0: turn 360 @30, true heading change (deg) | - | none: hwlog | 360.6 | - | MEASURE | reported 360 by gyro, 2602 ms |
| drive | r1, rtt 6: drive 50 @50, true distance (cm) | - | none: hwlog | 50.23 | - | MEASURE | reported 50.2 cm by gyro, 2186 ms |
| drive | r1, rtt 6: turn 90 @30, true heading change (deg) | - | none: hwlog | 91.8 | - | MEASURE | reported 92 by gyro, 768 ms |
| drive | r1, rtt 6: turn 360 @30, true heading change (deg) | - | none: hwlog | 361.4 | - | MEASURE | reported 361 by gyro, 2718 ms |
| drive | orugas, rtt 0: drive 50 @50, true distance (cm) | - | none: hwlog | 50.07 | - | MEASURE | reported 50.1 cm by encoders, 3299 ms |
| drive | orugas, rtt 0: turn 90 @30, true heading change (deg) | - | none: hwlog | 72.2 | - | MEASURE | reported 90.2 by encoders, 1214 ms |
| drive | orugas, rtt 0: turn 360 @30, true heading change (deg) | - | none: hwlog | 288.5 | - | MEASURE | reported 360.5 by encoders, 4622 ms |
| drive | orugas, rtt 6: drive 50 @50, true distance (cm) | - | none: hwlog | 50.08 | - | MEASURE | reported 50.1 cm by encoders, 3409 ms |
| drive | orugas, rtt 6: turn 90 @30, true heading change (deg) | - | none: hwlog | 72.3 | - | MEASURE | reported 90.4 by encoders, 1280 ms |
| drive | orugas, rtt 6: turn 360 @30, true heading change (deg) | - | none: hwlog | 288.4 | - | MEASURE | reported 360.5 by encoders, 4805 ms |
| drive | r1: drive 200 @50 with noise, /lateral/ p50 / p95 (cm), 30 seeds | - | none: hwlog | 5.6 / 12.9 | - | MEASURE | heading p50/p95 3.1/7.3 deg; along 197.3..199 cm |
| drive | orugas: drive 200 @50 with noise, /lateral/ p50 / p95 (cm), 30 seeds | - | none: hwlog | 7.7 / 16.7 | - | MEASURE | heading p50/p95 4.1/10.9 deg; along 190.5..193.7 cm |
| ultrasonic | wall square on at 5 cm | 5 cm | spec: lego_ug | 5 | 0 % | ok |  |
| ultrasonic | wall square on at 10 cm | 10 cm | spec: lego_ug | 10 | 0 % | ok |  |
| ultrasonic | wall square on at 30 cm | 30 cm | spec: lego_ug | 30 | 0 % | ok |  |
| ultrasonic | wall square on at 100 cm | 100 cm | spec: lego_ug | 100 | 0 % | ok |  |
| ultrasonic | wall square on at 200 cm | 200 cm | spec: lego_ug | 200 | 0 % | ok |  |
| ultrasonic | wall square on at 250 cm | 250 cm | spec: lego_ug | 250 | 0 % | ok |  |
| ultrasonic | wall square on at 300 cm | 255 cm | spec: lego_ug | 255 | 0 % | ok |  |
| ultrasonic | wall at 2 cm (under the 3 cm minimum) | - | none: lego_ug | 3 | - | MEASURE |  |
| ultrasonic | wall at 1 cm (under the 3 cm minimum) | - | none: lego_ug | 3 | - | MEASURE |  |
| ultrasonic | wall 50 cm away, 0 deg off square | 50 cm | spec: jj | 50 | 0 % | ok |  |
| ultrasonic | wall 50 cm away, 15 deg off square | 50..52 cm | spec: jj | 50.1 | -1.8 % | ok |  |
| ultrasonic | wall 50 cm away, 30 deg off square | no reliable echo (outside +-25 deg) | measured: jj | 255 | - | ok |  |
| ultrasonic | wall 50 cm away, 45 deg off square | no reliable echo | measured: jj | 255 | - | ok |  |
| ultrasonic | wall 50 cm away, 60 deg off square | no reliable echo | measured: jj | 255 | - | ok |  |
| ultrasonic | wall at 100 cm, noise on: spread (std of 50 reads) | 0..1 cm | spec: lego_ug | 0.31 | 0 cm | ok | compare with LEGO's +-1 cm; the provider declares noise 2 |
| ultrasonic | 5 cm post at 50 cm, lateral offset cm:reading | - | none: lego_ug | 0:50 3:50.1 6:50.3 10:50.6 15:255 20:255 | - | MEASURE |  |
| ultrasonic | 5 cm post at 100 cm, lateral offset cm:reading | - | none: lego_ug | 0:100 3:100.1 6:100.1 10:100.6 15:101.2 20:102.2 | - | MEASURE |  |
| ultrasonic | 5 cm post at 150 cm, lateral offset cm:reading | - | none: lego_ug | 0:150 3:255 6:150.2 10:150.2 15:150.8 20:255 | - | MEASURE |  |
| ultrasonic | 5 cm post anywhere inside the +-12 deg cone at 100-250 cm: positions missed | seen wherever it sits inside the cone | estimate: first_principles | 171/300 | - | SUSPECT | missed at distance/offset cm 100/8 100/18.5 150/3 150/3.5 150/4 150/4.5 150/5 150/10.5 ... |
| ultrasonic | room corner 70 cm ahead, walls at 45 deg | echo at the corner's distance | estimate: first_principles | 255 | - | SUSPECT |  |
| ultrasonic | box corner 70 cm ahead, faces at 45 deg | - | none: lego_ug | 255 | - | MEASURE |  |
| infrared | white wall at 38 cm | 40..41 pct | measured: issue518 | 41 | +1.2 % | ok |  |
| infrared | black wall at 38 cm (the twin has no surface colour) | 88..90 pct | measured: issue518 | 41 | -53.9 % | OFF |  |
| infrared | wall at 70 cm | 75..100 pct | spec: lego_ug | 75 | -14.3 % | ok |  |
| infrared | nearest wall distance that reads 100 (cm) | 70..94 cm | spec: ev3dev | 94 | +14.6 % | ok | curve cm:pct 5:5 10:11 20:21 30:32 38:41 50:53 70:75 80:85 90:96 100:100 |
| infrared | white wall at 38 cm, noise on: std of 100 reads | 0.3..0.6 pct | measured: issue518 | 0.57 | +26.7 % | ok | range 39..42; the provider declares noise 3 |
| gyro | turn 90 @30: /gyro - true/, p95 over 30 seeds | 0..3 deg | spec: lego_ug | 3.5 | +0.5 deg | OFF | p50 1.5 |
| gyro | clockwise 360 @30: what the gyro reads (mean, 30 seeds) | 351..355 deg | measured: ev3basic_gyro | 359.7 | +1.9 % | OFF | range 346.9..376.8 |
| gyro | counter-clockwise 360 @30: what the gyro reads (mean) | 359..363 deg | measured: ev3basic_gyro | 359.8 | -0.3 % | ok | range 348..377 |
| gyro | clockwise 360 @5 (slow): what the gyro reads (mean, 5 seeds) | 326..353 deg | measured: ev3basic_gyro | 358.9 | +5.7 % | OFF |  |
| gyro | at rest 60 s after a reset: /angle/ (default noise) | 0..1 deg | measured: ev3basic_gyro | 0 | 0 deg | ok | noise.gyro_drift_deg_s is 0 by default |
| gyro | spin at 100 % on wheels 5.6 / axle 12: rate_deg_s read | 440 deg/s | spec: lego_ug | 476 | +8.2 % | OFF | the declared range of rate_deg_s is -440..440 |
| gyro | reset while turning @50, then still: drift (deg/s) | - | none: ev3basic_gyro | -231.4 | - | MEASURE |  |
| colour | reflected across a line edge: 90 % to 10 % width (cm) | - | none: lego_ug | 1.5 | - | MEASURE | spot radius 1 cm (body.color_spot_radius_cm), no height |
| colour | reflected on white / on black | - | none: ev3dev | 85 / 11 | - | MEASURE |  |
| colour | color id approaching the line, cm from its centre:id | - | none: ev3dev | -3:6 -2.5:6 -2:6 -1.5:6 -1:1 -0.5:1 0:1 | - | MEASURE | the floor under the spot's centre: black or white, never an in-between colour |
| colour | rgb on white | - | none: ev3dev | [384,381,370] | - | MEASURE | the floor colour's sRGB scaled by 400/255, not a sensor's raw counts |
| colour | ambient_pct anywhere | - | none: ev3dev | 5 | - | MEASURE | a constant: the world has no light |
| touch | front-to-wall gap cm:pressed | - | none: lego_ug | 2:0 1:0 0.8:0 0.6:1 0.4:1 0.2:1 | - | MEASURE |  |
| rates | ultrasonic read at 50 Hz while moving: reads that changed / reads | - | none: ev3dev | 38/39 | - | MEASURE | smallest step 0.1 cm: a fresh value on every read, at any rate |
| battery | battery voltage_v at rest | 8.06..8.27 V | measured: hwlog | 7.9 | -3.2 % | ok |  |
| battery | battery voltage_v with both drive motors at 100 % | - | none: hwlog | 7.9 | - | MEASURE | motor speed never depends on it in the twin |
| link | read_device round trip, twin in-process, real clock: p50 / p95 ms | - | none: hwlog | 0.1 / 2.68 | - | MEASURE | the twin's cable is a microtask: a real USB round trip adds to every read and to every host-decided stop |
| link | tone 440 Hz 500 ms: how long the call takes (ms) | 0..30 ms | derived: lms2012 | 6.5 | 0 ms | ok | reason completed; tones logged 1 |
| time | simulated / wall-clock time over 15 s, reading at 50 Hz | 1 x | spec: first_principles | 1 | 0 % | ok |  |
| time | simulated / wall-clock time over 15 s, reading at 1 Hz | 1 x | spec: first_principles | 1 | 0 % | ok |  |
| time | pose difference, drive 60 cm unwatched vs read at 50 Hz (cm) | 0 cm | spec: first_principles | 0.0004 | 0 cm | ok | noise on, seed 7, orugas in its room's noise |

</details>
