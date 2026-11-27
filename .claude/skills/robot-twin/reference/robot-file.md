# The robot file: template and every field

One JSON file holds the robot: the model reads `profile`, the real brick uses `hardware` and `pair`, and the twin uses everything plus `twin`.
The contract is `<clone>/CONTRACT.md` §3. A top-level key that is not listed here stops the start.

## Template: two drive motors and sensors

Copy it, then change it to match the robot. Delete each role, port and section that the robot does not have.

```json
{
  "description": "One sentence for people: what this robot is and who built it.",
  "pair": { "left": "B", "right": "C" },
  "hardware": { "low_battery_v": 6.5, "max_tone_ms": 5000, "tone_volume_pct": 50, "speech_volume_pct": 100 },
  "profile": {
    "id": "my-robot",
    "roles": {
      "left_wheel": "ev3.B",
      "right_wheel": "ev3.C",
      "arm": "ev3.A",
      "touch": "ev3.S1",
      "gyro": "ev3.S2",
      "color": "ev3.S3",
      "distance": "ev3.S4"
    },
    "drivetrain": {
      "type": "differential",
      "pair_device": "ev3.pair",
      "wheel_diameter_cm": 5.6,
      "axle_track_cm": 12,
      "forward_sign": 1,
      "max_drive_cm": 100,
      "max_turn_deg": 360,
      "heading": { "device": "gyro", "channel": "angle_deg" }
    },
    "limits": { "max_speed_pct": 60, "max_command_ms": 15000, "max_program_ms": 120000, "max_loop_ms": 60000 },
    "notes": [
      "The arm motor on A lifts the arm with positive degrees, about 90 degrees from down to up.",
      "The colour sensor points down, 7 cm ahead of the axle."
    ]
  },
  "twin": {
    "body": { "front_cm": 10, "back_cm": 8, "half_width_cm": 7, "color_sensor_x_cm": 7, "color_spot_radius_cm": 1, "distance_sensor_x_cm": 9 },
    "ev3": {
      "motors": { "A": "medium", "B": "large", "C": "large" },
      "sensors": { "1": "touch", "2": "gyro", "3": "color", "4": "ultrasonic" }
    },
    "view": { "drive": "wheels" }
  }
}
```

## A robot with no drive (an arm, a crane, a sensor station)

Delete `pair` and `profile.drivetrain`. Every motor is then a device of its own, and `drive`, `turn` and `arc` answer `unsupported`.
A robot with four actuators and no sensor, or four sensors and no motor, is a valid file.

## Coordinates

Every length is in centimetres from the centre of the drive axle, on the floor: `x` ahead, `y` to the left, `z` up.
"Ahead" is the direction the robot drives with a positive `drive`.
For a robot with no drive, pick one end as the front and say which in `notes`.

## Every selectable option

| Field | Allowed values | Default when left out | What it is |
|---|---|---|---|
| `description` | text | none | for people only |
| `pair.left`, `pair.right` | two different ports of `A`, `B`, `C`, `D` | no `pair`: no drive | the two drive motors, left and right as seen from behind the robot looking ahead |
| `hardware.low_battery_v` | number > 0 | required | battery warning, volts. 6.5 fits the EV3 |
| `hardware.max_tone_ms` | number > 0 | required | longest tone |
| `hardware.tone_volume_pct` | number > 0 | required | volume of tones |
| `hardware.speech_volume_pct` | 1 to 100 | required only for an EV3 on ev3dev | volume of speech |
| `hardware.ir_channel` | 1, 2, 3, 4 | 1 | the channel switch of the infrared remote |
| `profile.id` | starts with a lowercase letter or digit, then lowercase letters, digits, `_`, `-`; at most 44 characters (its twin adds `-sim`) | required | the robot's id; its twin is `<id>-sim` |
| `profile.roles.<name>` | a device id: `ev3.A` to `ev3.D`, `ev3.S1` to `ev3.S4`, `ev3.pair`, `sim.camera`, or a page's device | `{}` | a free name for what a device does: `left_wheel`, `arm`, `gripper`, `lift`, `head`, `eyes`. On a twin, a role on a port with nothing plugged in stops the start |
| `profile.drivetrain` | the object below | none: no drive tools | needs `pair` |
| `drivetrain.type` | `"differential"` | required | two driven sides, wheels or tracks |
| `drivetrain.pair_device` | `"ev3.pair"` | required | the synced pair of `pair` |
| `drivetrain.wheel_diameter_cm` | number > 0 | required | [parts.md](parts.md); state 6 calibrates it |
| `drivetrain.axle_track_cm` | number > 0 | required | distance between the middles of the two wheels or tracks; state 6 calibrates it |
| `drivetrain.forward_sign` | 1 or -1 | required | -1 when a positive `drive` moves the real robot backward |
| `drivetrain.max_drive_cm`, `max_turn_deg` | number > 0 | required | the longest single move |
| `drivetrain.heading` | `{"device": <role or id>, "channel": "angle_deg"}` | none: the heading comes from the wheel encoders | only with a gyro |
| `profile.limits.*` | numbers > 0 | required | `max_speed_pct` (100 is full speed), `max_command_ms`, `max_program_ms`, `max_loop_ms` |
| `profile.notes` | array of text | required (may be `[]`) | facts for the model: which way an actuator moves with positive degrees and its range, where a sensor looks, what the phone is for |
| `twin` | `{body?, ev3?, view?}` | none: the twin takes these three from its world | the build. With `twin`, a part left out takes the default below, never the world's |
| `twin.ev3.motors.<A-D>` | `"large"`, `"medium"` | nothing plugged | what is plugged into each motor port |
| `twin.ev3.sensors.<1-4>` | `"touch"`, `"color"`, `"ultrasonic"`, `"gyro"`, `"ir"` | nothing plugged | what is plugged into each sensor port |
| `twin.body.front_cm` | number >= 0 | 8 | how far the robot reaches ahead of the axle |
| `twin.body.back_cm` | number >= 0 | 10 | how far it reaches behind the axle (a caster, a bumper) |
| `twin.body.half_width_cm` | number >= 0 | 6 | half of the full width, across the wheels or tracks |
| `twin.body.color_sensor_x_cm` | number >= 0 | 7 | where the colour sensor reads the floor, ahead of the axle |
| `twin.body.color_spot_radius_cm` | number >= 0 | 1 | the size of the spot it reads |
| `twin.body.distance_sensor_x_cm` | number >= 0 | 8 | where the ultrasonic or infrared sensor looks out, ahead of the axle |
| `twin.view` | object | the default look | how the twin looks in 3D: see below |

`twin.body` is a rectangle. The physics uses it for collisions and for what the colour and distance sensors see.
The colour sensor always reads the floor on the centre line, and the distance sensor always looks straight ahead on the centre line.
A sensor that sits elsewhere or faces elsewhere: write where in `notes`, and use the closest `x` for the body.

## `twin.view`: the look

The fields are listed in the header comment of `<clone>/apps/twin-view/src/look.ts`. Read that header now; it is the only list, and it changes.
At the time of writing it has: `drive` (`"tracks"` or `"wheels"`), `brick` (where the brick sits, which end its screen faces), `phone` (a phone standing across the body: where, how high its bottom edge, which end its screen faces), `sensors` (where each sensor port's sensor sits, by port), `bumper` and `label`.
The page never fails on a bad look field: it draws the default instead. Check the look by eye in state 5 SHOW.

## A phone as the robot's eyes

When a phone stands on the robot:

1. Put it in `twin.view.phone`: `x_cm` where it stands, `bottom_cm` how high its bottom edge is, `screen` `"front"` or `"back"`.
2. Add a note: "A phone stands at the front with its screen facing forward; it joins as a page and lends its camera, screen and speaker."
3. On the real robot, the phone opens the page of `--pages` and lends its camera, screen and speaker to the robot (README "Peripheral pages on a phone"). The twin's own camera is `sim.camera`.

## What a twin cannot have

| On the real robot | In the twin |
|---|---|
| An NXT light, sound or temperature sensor, or a sensor of another maker | Nothing on that port. Give it no role, or the twin stops at start; the model can still use it on the real robot by its id, `ev3.S<n>` |
| An NXT touch or ultrasonic sensor | `"touch"` or `"ultrasonic"` |
| Three or more driven wheels, legs, steering | Not simulated: the drive is two sides. Leave out `pair` and `drivetrain`, and describe the build in `notes` |
| A sensor that faces sideways, up, or behind | It faces as in the table above; say where it really faces in `notes` |
