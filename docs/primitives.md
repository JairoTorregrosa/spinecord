# Primitives map

What a model can do today, and what is missing. Each missing row is one issue and one PR. Rule for every row: generic, declared by a device manifest or a profile, no tool added for a single use.

Legend: ✅ shipped · 🟡 partial · ⬜ missing. **Where** = the package that owns it.

## Sense

| Primitive | How the model reaches it | State | Where |
|---|---|---|---|
| Read any channel, all channels, sample over time | `read_device` `read_all` `sample_device` | ✅ | runtime |
| Wait for a condition, stop a move on a condition | `wait_until`, `until` | ✅ | runtime |
| Wheel odometry pose (x, y, heading) from encoders | `pose` channel on the drivetrain | ⬜ | runtime |
| First-person camera frame | `camera` device, image channel | 🟡 twin only | sim-world · a camera provider |
| Overhead pose of every robot (fiducial markers) | `pose_tracker` device | ⬜ | a camera provider |
| Phone IMU, compass, shake | `imu` device | ⬜ | a phone provider |
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
| EV3 on ev3dev over SSH | 🟡 bridge version 4 tested against a fake sysfs tree; not run on a real brick (bridge version 1 ran on one, 2026-11-21) | driver-ev3dev |
| Twin in the server's process | ✅ | apps/local · sim-ev3 |
| Phone or microcontroller as extra devices | ⬜ | a new provider |
| Model docs as MCP resources (robot notes, device specs) | ⬜ | apps/local |
