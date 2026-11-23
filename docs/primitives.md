# Primitives map

What a model can do today, and what is missing. Each missing row is one issue and one PR. Rule for every row: generic, declared by a device manifest or a profile, no tool added for a single use.

Legend: ✅ shipped · 🟡 partial · ⬜ missing. **Where** = the package that owns it.

## Sense

| Primitive | How the model reaches it | State | Where |
|---|---|---|---|
| Read any channel, all channels, sample over time | `read_device` `read_all` `sample_device` | ✅ | runtime |
| A sensor without an entry (third-party, NXT color, any type the firmware or driver reports) | kind `sensor`: `values` of its current mode, `mode`, `set_mode{mode}`, `send{command}` when the driver lists commands | 🟡 emulator and fake sysfs only | drivers |
| NXT touch, light, sound, ultrasonic, temperature | kinds `touch`, `light`, `sound`, `ultrasonic`, `temperature` | 🟡 emulator and fake sysfs only | drivers |
| Infrared beacon and remote on channels 1-4 | `hardware.ir_channel` in the robot file; `beacon_heading`, `beacon_distance_pct`, `remote_buttons` read that channel | 🟡 emulator and fake sysfs only | drivers |
| Wait for a condition, stop a move on a condition | `wait_until`, `until` | ✅ | runtime |
| Wheel odometry pose (x, y, heading) from encoders | `pose` channel on the drivetrain | ⬜ | runtime |
| First-person camera frame | `camera` device, image channel | 🟡 twin only | sim-world · a camera provider |
| Overhead pose of every robot (fiducial markers) | `pose_tracker` device | ⬜ | a camera provider |
| Phone IMU, compass, shake | `imu` device of a peripheral page: tilt, heading, acceleration, rotation rate, `shaken` (pushed) | 🟡 fake browser and Chrome's sensor emulation only | apps/peripheral-page |
| Listen: speech to text, loudness | `microphone` device | ⬜ | a phone provider |
| Sensor calibration (color white/black, gyro zero) | `calibrate{}` command per sensor | ⬜ | drivers |

## Act

| Primitive | How the model reaches it | State | Where |
|---|---|---|---|
| Drive, turn, arc (any differential drivetrain) | `drive` `turn` `arc` | ✅ | runtime |
| Any bounded device command | `command_device` | ✅ | runtime |
| Speak text | `speak{text, voice?, rate_wpm?}` on `speaker` when the device can (CONTRACT §2.3) | 🟡 ev3dev (`espeak`) and twin (`sim.speaker`, records `last_spoken`) | driver-ev3dev · sim-world |
| Play a sound file | `play{name}` on `speaker` | ⬜ | drivers |
| Show text and simple images | `text{lines}` `image{png}` on `display` | 🟡 stock only | driver-ev3dev |
| Lights | `led.set{pattern}` | ✅ | drivers |
| Go to a point | program over `pose` + `turn` + `drive` | ⬜ | runtime |

## Learn and reuse

| Primitive | How the model reaches it | State | Where |
|---|---|---|---|
| Programs as data, run next to the hardware | `run_program{body, success?}` | ✅ | runtime |
| A control law at a fixed rate next to the hardware (hold an angle, follow a line), supervised by the model | `run_loop` `supervise_loop` ([`loops.md`](loops.md)) | 🟡 stock EV3 and twin (host executor; not run on a real brick); ev3dev ⬜ | runtime · apps/local · drivers |
| Program parameters (`drive {distance_cm: $d}`) | `params` in program + `run_program{args}` | ⬜ | protocol · runtime |
| Train a behavior from a declarative reward | training spec on the twin | 🟡 sim only, no tool | sim-world |

## Coordinate

| Primitive | How the model reaches it | State | Where |
|---|---|---|---|
| Many robots in one process, each with its own state | `list_robots`, `robot_id` on every tool | ✅ | apps/local |
| Shared arena state (where every robot is) | `pose_tracker` + `list_robots` poses | ⬜ | apps/local · a camera provider |

## Connect

What has run on a real brick, with dates and commits, and the checklist of what to run: [`hardware-log.md`](hardware-log.md).

| Primitive | State | Where |
|---|---|---|
| EV3 stock firmware over USB (WebHID bridge page) | 🟡 tested against the byte-level emulator; not run on a real brick | driver-ev3 · apps/robot-page · apps/local |
| EV3 over Bluetooth (Web Serial) | ⬜ | driver-ev3 |
| EV3 on ev3dev over SSH | 🟡 bridge version 4 ran on a real brick on 2026-11-22 (stop, `Esc`, the square, `kill -9`, the guard); version 5 (a hello that may leave out `pair`) and version 6 (NXT and generic sensors, an infrared channel other than 1) have not; `until`, the watchdog and brick off at start tested against a fake sysfs tree only | driver-ev3dev |
| Twin in the server's process | ✅ | apps/local · sim-ev3 |
| Phone or microcontroller as extra devices | ⬜ | a new provider |
| Model docs as MCP resources (robot notes, device specs) | ⬜ | apps/local |
