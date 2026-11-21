# Primitives map

What a model can do today, and what is missing. Each missing row is one issue and one PR. Rule for every row: generic, declared by a device manifest or a profile, no tool added for a single use.

Legend: ✅ shipped · 🟡 partial · ⬜ missing. **Where** = the package that owns it.

## Sense

| Primitive | How the model reaches it | State | Where |
|---|---|---|---|
| Read any channel, all channels, sample over time | `read_device` `read_all` `sample_device` | ✅ | runtime |
| Wait for a condition, stop a move on a condition | `wait_until`, `until` | ✅ | runtime |
| Wheel odometry pose (x, y, heading) from encoders | `pose` channel on the drivetrain | ⬜ | runtime |
| First-person camera frame | `camera` device, image channel | 🟡 twin only | sim-world · device page |
| Overhead pose of every robot (fiducial markers) | `pose_tracker` device | ⬜ | device page |
| Phone IMU, compass, shake | `imu` device | ⬜ | device page |
| Listen: speech to text, loudness | `microphone` device | ⬜ | device page |
| Sensor calibration (color white/black, gyro zero) | `calibrate{}` command per sensor | ⬜ | drivers |

## Act

| Primitive | How the model reaches it | State | Where |
|---|---|---|---|
| Drive, turn, arc (any differential drivetrain) | `drive` `turn` `arc` | ✅ | runtime |
| Any bounded device command | `command_device` | ✅ | runtime |
| Speak text | `speak{text, voice?, rate?}` on `speaker` when the device can | ⬜ | driver-ev3dev · device page · sim-world |
| Play a sound file | `play{name}` on `speaker` | ⬜ | drivers |
| Show text and simple images | `text{lines}` `image{png}` on `display` | 🟡 stock only | driver-ev3dev |
| Lights | `led.set{pattern}` | ✅ | drivers |
| Go to a point | program over `pose` + `turn` + `drive` | ⬜ | library |

## Learn and reuse

| Primitive | How the model reaches it | State | Where |
|---|---|---|---|
| Programs as data, verified on a twin | `save_program` `verify_program` `run_program` | ✅ | server · runtime |
| Program parameters (`drive {distance_cm: $d}`) | `params` in program + `run_program{args}` | ⬜ | protocol · runtime |
| Train a behavior from a declarative reward | training spec on the twin | 🟡 sim only, no tool | sim-world · server |
| Shared library of community programs | `list_programs` across principals | ✅ | server |

## Coordinate

| Primitive | How the model reaches it | State | Where |
|---|---|---|---|
| Many robots, one endpoint, per-principal access | `list_robots`, principals | ✅ | server |
| Admin takes control, stops all | `take_control` `stop_all` | ✅ | server |
| Shared arena state (where every robot is) | `pose_tracker` + `list_robots` poses | ⬜ | server · device page |
| Episodes with time and interventions | `start_episode` … | ✅ | server |

## Connect

| Primitive | State | Where |
|---|---|---|
| EV3 stock firmware over USB (WebHID) | 🟡 driver done, page missing | driver-ev3 · apps/robot-page |
| EV3 over Bluetooth (Web Serial) | ⬜ | driver-ev3 |
| EV3 on ev3dev over SSH | ✅ real robot | driver-ev3dev |
| Twin runner (headless, CI, demos) | ⬜ | apps/twin-runner |
| Phone or microcontroller as extra devices | ⬜ | apps/device-page |
| Deployed server (Cloudflare) | ⬜ | server |
| Model docs as MCP resources (robot notes, device specs) | ⬜ | server |
