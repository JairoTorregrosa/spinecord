# Loops: worked examples

A loop (CONTRACT §5a) is a control law given as data: signals to read, outputs to refresh, the terms that make each output, guards that end it, and params that can change while it runs. The four specs below are complete `LoopSpec` values. The device names are roles and ids of an example robot; a loop takes whatever the robot's devices are called.

Every gain here is a plausible starting point of the right order of magnitude, not a measured one. Each must be tuned on the robot: read the trace of a short run, change one param, look again. Signs depend on how a sensor and a motor are mounted; the first run of any law uses a short `duration_ms`, a low `limit` and a hand near the robot.

`packages/protocol/loop.test.ts` runs these specs as they are printed here through `validateLoop`, and runs C1, C2 and C4, as printed, against small simulated plants.

## C1. Balancing on two wheels (100 Hz)

Preparation, robot held upright and still: read the gyro's `rate_deg_s` by name so the rate channel is the active one.

```json
{ "rate_hz": 100, "duration_ms": 60000, "attention_ms": 10000,
  "signals": {
    "pitch_rate": { "device": "gyro",  "channel": "rate_deg_s",  "zero": {"mean_ms": 1000}, "detrend_s": 20 },
    "left":       { "device": "ev3.B", "channel": "position_deg", "zero": "start", "smooth_ms": 20 },
    "right":      { "device": "ev3.C", "channel": "position_deg", "zero": "start", "smooth_ms": 20 }
  },
  "params": { "travel": 0, "steer": 0 },
  "outputs": [
    { "device": "ev3.B", "command": "power", "limit": [-100, 100], "terms": [
        { "signal": "pitch_rate", "gain": 0.4 },
        { "signal": "pitch_rate", "of": "integral", "gain": 14 },
        { "signal": "left",  "setpoint": "travel", "gain": 0.1 },
        { "signal": "right", "setpoint": "travel", "gain": 0.1 },
        { "signal": "left",  "of": "derivative", "gain": 0.1 },
        { "signal": "right", "of": "derivative", "gain": 0.1 },
        { "feed": "steer", "gain": 1 } ] },
    { "device": "ev3.C", "command": "power", "limit": [-100, 100], "terms": [
        { "signal": "pitch_rate", "gain": 0.4 },
        { "signal": "pitch_rate", "of": "integral", "gain": 14 },
        { "signal": "left",  "setpoint": "travel", "gain": 0.1 },
        { "signal": "right", "setpoint": "travel", "gain": 0.1 },
        { "signal": "left",  "of": "derivative", "gain": 0.1 },
        { "signal": "right", "of": "derivative", "gain": 0.1 },
        { "feed": "steer", "gain": -1 } ] }
  ],
  "guards": [
    { "name": "fallen",  "signal": "pitch_rate", "of": "integral", "op": "abs_gt", "value": 45 },
    { "name": "runaway", "signal": "left", "of": "derivative", "op": "abs_gt", "value": 900, "for_ms": 500 }
  ] }
```

The law is state feedback on four states: body rate (the gyro's value), body angle (the gyro's integral: the integral of a rate is the angle, and it carries no `clamp`, so it keeps tracking the body while the motors saturate), wheel angle (the encoders' value) and wheel speed (the encoders' derivative). For the first second every output is 0 while the gyro's offset is measured; a robot that moves in that second ends the loop with `not_still`.

Params steer it while it balances: `{travel: 720}` over a ramp of 4000 ms rolls the robot two wheel turns forward in 4 s; `{steer: 10}` turns it.

The four gains interact, so they are tuned together. The ones printed are the set that holds the plant of the test (a 0.6 kg body with its mass 9 cm above the axle, 5.6 cm wheels, two motors), found by a search over simulated runs. Gains belong to one robot: a real one starts from these and is tuned on the floor.

## C2. Line following (50 Hz)

Preparation: read `reflected_pct` on the line and beside it; `edge` is the midpoint. The signs below follow the left edge of a dark line: brighter than `edge` → the left wheel speeds up and the robot curves right, back onto the edge.

```json
{ "rate_hz": 50, "duration_ms": 30000,
  "signals": { "light":  { "device": "color", "channel": "reflected_pct" },
               "bumper": { "device": "touch", "channel": "pressed" } },
  "params": { "edge": 35, "speed": 20, "k_left": 0.5, "k_right": -0.5 },
  "outputs": [
    { "device": "left_wheel",  "command": "run_time", "limit": [-40, 40], "terms": [
        { "feed": "speed" },
        { "signal": "light", "setpoint": "edge", "gain": "k_left" },
        { "signal": "light", "of": "derivative", "gain": 0.02 } ] },
    { "device": "right_wheel", "command": "run_time", "limit": [-40, 40], "terms": [
        { "feed": "speed" },
        { "signal": "light", "setpoint": "edge", "gain": "k_right" },
        { "signal": "light", "of": "derivative", "gain": -0.02 } ] }
  ],
  "guards": [ { "name": "line_lost", "signal": "light",  "op": "gt", "value": 85, "for_ms": 1500 },
              { "name": "bumper",    "signal": "bumper", "op": "gt", "value": 0.5 } ] }
```

The two proportional gains are params, so the steering can be made sharper or softer while the robot drives; `speed` slows it for a tight curve.

## C3. Wall following (20 Hz; the distance sensor looks to the right)

```json
{ "rate_hz": 20, "duration_ms": 30000,
  "signals": { "wall": { "device": "distance", "channel": "distance_cm", "smooth_ms": 100 } },
  "params": { "gap": 20, "speed": 20 },
  "outputs": [
    { "device": "left_wheel",  "command": "run_time", "limit": [0, 40], "terms": [
        { "feed": "speed" },
        { "signal": "wall", "setpoint": "gap", "gain": 1.5 },
        { "signal": "wall", "of": "derivative", "gain": 0.5 } ] },
    { "device": "right_wheel", "command": "run_time", "limit": [0, 40], "terms": [
        { "feed": "speed" },
        { "signal": "wall", "setpoint": "gap", "gain": -1.5 },
        { "signal": "wall", "of": "derivative", "gain": -0.5 } ] }
  ],
  "guards": [ { "name": "wall_lost", "signal": "wall", "op": "gt", "value": 100, "for_ms": 1000 } ] }
```

Wall on the right: farther than `gap` → the left wheel speeds up and the right one slows, so the robot curves toward the wall. A sensor that looks left swaps the two signs.

## C4. Holding an arm at an angle (50 Hz)

```json
{ "rate_hz": 50, "duration_ms": 60000,
  "signals": { "angle": { "device": "ev3.A", "channel": "position_deg", "smooth_ms": 20 } },
  "params": { "target": 45 },
  "outputs": [ { "device": "ev3.A", "command": "power", "limit": [-60, 60], "terms": [
      { "signal": "angle", "setpoint": "target", "gain": -2.0 },
      { "signal": "angle", "of": "integral", "setpoint": "target", "gain": -4.0, "clamp": 10 },
      { "signal": "angle", "of": "derivative", "gain": -0.05 } ] } ],
  "guards": [ { "name": "out_of_range", "signal": "angle", "op": "abs_gt", "value": 200 } ] }
```

A PID: three terms on one signal. Setting `{target: 90}` over a ramp of 1000 ms moves the arm and keeps holding. The gains are negative because the motor raises the angle it is regulated on (§5a, Law). `clamp: 10` (degree-seconds) bounds what the integral term can add to 40 % of power.

## The same data, other uses

- Keep a distance: C3's signal looking forward, both wheels with the same sign.
- Hold a speed: a term `of: derivative` on an encoder with the speed as its setpoint.
- Two independent motors at once: two outputs with one `feed` term each, no feedback term; `params` are the two speeds; guards on each motor's `position_deg` end it.
- A turntable that tracks a beacon: one output, one term on `beacon_heading`.
