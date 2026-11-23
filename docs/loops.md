# Loops: worked examples

A loop (CONTRACT §5a) is a control law given as data: signals to read, outputs to refresh, the terms that make each output, guards that end it, and params that can change while it runs. The five specs below are complete `LoopSpec` values. The device names are roles and ids of an example robot; a loop takes whatever the robot's devices are called.

Every gain here is a plausible starting point of the right order of magnitude, not a measured one. Each must be tuned on the robot: read the trace of a short run, change one param, look again. Signs depend on how a sensor and a motor are mounted; the first run of any law uses a short `duration_ms`, a low `limit` and a hand near the robot.

`packages/protocol/loop.test.ts` runs these specs as they are printed here through `validateLoop`, and runs C1, C2 and C4, as printed, against small simulated plants. `apps/local/test/loop.test.ts` runs C2, C4 and C5, as printed, through `run_loop` on the twin, and `apps/local/test/pages.test.ts` runs C5 at 5 Hz on real time, with a fake page client joined over the page socket.

A spec is the input of `run_loop` with `robot_id` added. How a model runs one and supervises it is at the end of this page.

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

## C5. Tilt-steering with a phone (20 Hz)

A phone joins the robot as a peripheral page named `phone` and lends its motion sensor (`phone.imu`, CONTRACT §2.4). Tilting the phone forward drives the robot, tilting it sideways steers it, shaking it ends the loop.

```json
{ "rate_hz": 20, "duration_ms": 60000,
  "signals": { "pitch": { "device": "phone.imu", "channel": "pitch_deg" },
               "roll":  { "device": "phone.imu", "channel": "roll_deg" },
               "shake": { "device": "phone.imu", "channel": "shaken" } },
  "params": { "k_drive": 1, "k_left": 0.5, "k_right": -0.5 },
  "outputs": [
    { "device": "left_wheel",  "command": "run_time", "limit": [-40, 40], "terms": [
        { "signal": "pitch", "gain": "k_drive" },
        { "signal": "roll",  "gain": "k_left" } ] },
    { "device": "right_wheel", "command": "run_time", "limit": [-40, 40], "terms": [
        { "signal": "pitch", "gain": "k_drive" },
        { "signal": "roll",  "gain": "k_right" } ] }
  ],
  "guards": [ { "name": "shaken", "signal": "shake", "op": "gt", "value": 0.5 } ] }
```

Only value terms. A page pushes a channel when its browser event fires, and the imu declares `max_rate_hz: 20`: a loop faster than that reads the same value on several ticks (the plan says so in `notes`, as for any sensor slower than the loop), so a derivative term on a pushed channel is 0 between pushes and a spike at each one. A phone held flat gives 0 on both wheels; 20° of roll gives ±10 % of speed, the robot turning toward the lower side. Signs depend on how the phone is held: the first run uses a short `duration_ms` and reads the trace.

The page is an input and nothing more: a page moves nothing, so its devices are never an output, and a channel it does not push (a camera's `width_px`) is refused with `unsupported`. While the loop runs, the server pings the phone every 100 ms. A phone that locks its screen or loses the network is silent: 300 ms after its last answer its values are ticks without a value, and three of those end the loop with `input_lost`, both wheels braked. A paused page or a sensor reported down ends it the same way. The loop runs in the server's process, beside the robot's own provider: a robot whose provider runs loops on the device would never see the phone's values, and the mix is refused with `unsupported`.

## The same data, other uses

- Keep a distance: C3's signal looking forward, both wheels with the same sign.
- Hold a speed: a term `of: derivative` on an encoder with the speed as its setpoint.
- Two independent motors at once: two outputs with one `feed` term each, no feedback term; `params` are the two speeds; guards on each motor's `position_deg` end it.
- A turntable that tracks a beacon: one output, one term on `beacon_heading`.

## Running and supervising C2 on a stock EV3

On a stock EV3 over USB, a loop runs in the server's process (CONTRACT §5a): `describe_robot` shows `loop: {runs_on: "host", max_rate_hz: 50}` (the twin: 100). Each tick is one packet through the bridge page: a timed refresh of each wheel's `run_time` for `hold_ms` (3 periods, 60 ms at 50 Hz), then the reads of the color and touch sensors. The model is never inside the loop: it starts it, reads its reports and changes its params.

1. Look. `describe_device` on `left_wheel` shows `run_time` with `drives: {arg: "speed_pct", max_hold_ms: 250}`: a loop can refresh it. `describe_device` on `color` shows whether `reflected_pct` is the active channel; if it is not, `read_device` names it while the robot is idle (a loop never switches a mode).
2. Calibrate. With the sensor over the line, then beside it, `read_device` on `color`; `edge` is the midpoint of the two readings.
3. Start. `run_loop` with C2, `robot_id` and that `edge` in `params`. It answers after 20 ticks (0.4 s) with the first report: `state: running`, `runs_on: host`, and a note that the touch sensor updates at 20 Hz, under the loop's 50. The robot is `looping`.
4. Supervise. Call `supervise_loop` with `wait_ms` (at most 30000) in a row: each call answers when the loop ends or the time passes, and renews the attention window (`attention_ms`, 15 s by default). A loop nobody supervises for that long ends with `unattended`. Each report holds the statistics since the previous one and a trace at `trace_hz` (`t_ms`, `light`, `bumper`, `out0`, `out1`). Steer through the params only: sharper steering is `{params: {k_left: 0.7, k_right: -0.7}}`, a slower robot for a tight curve `{params: {speed: 15}, ramp_ms: 500}`.
5. Meanwhile. `read_device` and `read_all` run while the loop does. `drive`, `turn`, `arc`, `run_program`, a second `run_loop` and a moving `command_device` answer `busy`, and so does any command on a wheel the loop drives; the message names `supervise_loop` and `stop`.
6. The end. `stop` ends it (`preempted`). It also ends by itself: `completed` at `duration_ms`, `guard` with the guard's name (`line_lost`, `bumper`), `unattended`, `overrun` when the link cannot keep 50 ticks a second, `input_lost` when a sensor stops answering. Every end brakes both wheels and takes the path of `stop`: the robot is `idle` once every motor reads 0, else `fault`. The next `supervise_loop` returns the final report, with `reason`, until the next `run_loop`.
7. If the process, the page or the cable goes. The brick ends each refresh by itself 60 ms after the latest one, and the bridge page brakes every motor when its socket closes. The robot is `offline`, and the report is gone with the link.

The calls in order, as a script would make them:

```text
describe_robot   {robot_id: "r1"}                              → loop: {runs_on: "host", max_rate_hz: 50}
read_device      {robot_id: "r1", device: "color"}             → on the line, then beside it: edge = midpoint
run_loop         {robot_id: "r1", ...C2, params: {...C2.params, edge}}   → {state: "running", ticks: 20, ...}
supervise_loop   {robot_id: "r1", wait_ms: 10000}              → {state: "running", trace, signals, outputs, ...}
supervise_loop   {robot_id: "r1", params: {speed: 15}, ramp_ms: 500, wait_ms: 10000}
stop             {robot_id: "r1"}                              → {motors_stopped: true, activity: "idle"}
supervise_loop   {robot_id: "r1"}                              → {state: "ended", reason: "preempted", ...}
```

The same calls run on the twin, `--twin` with `--world packages/sim-world/examples/line-oval.json`: C2 as printed goes once around the oval in about 16 s of simulated time, with the axle within 2.7 cm of the line's centre, and the stock code path carries every tick (`apps/local/test/loop.test.ts`). The 50 Hz of the stock path has not been measured on a real brick (`docs/hardware-log.md`).
