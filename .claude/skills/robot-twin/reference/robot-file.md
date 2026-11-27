# The robot file: template, parts and every field

One JSON file holds the robot: the model reads `profile`, the real brick uses `hardware` and `pair`, the twin uses everything plus `twin`. The contract is `<clone>/CONTRACT.md` §3. A top-level key not listed here stops the start.

## Template: a two-motor drive base, nothing confirmed

Copy it. Every value in it is a placeholder, and `twin.unconfirmed` says so: fill each value from state 1, and take a token out only when its value has a source (SKILL.md "Confirm"). Its ports B and C are placeholders like every other value. Add parts from "Parts" below.

```json
{
  "description": "One sentence for people: what this robot is and who built it.",
  "pair": { "left": "B", "right": "C" },
  "hardware": { "low_battery_v": 6.5, "max_tone_ms": 5000, "tone_volume_pct": 50, "speech_volume_pct": 100 },
  "profile": {
    "id": "my-robot",
    "roles": { "left_wheel": "ev3.B", "right_wheel": "ev3.C" },
    "drivetrain": {
      "type": "differential",
      "pair_device": "ev3.pair",
      "wheel_diameter_cm": 5.6,
      "axle_track_cm": 12,
      "forward_sign": 1,
      "max_drive_cm": 100,
      "max_turn_deg": 360
    },
    "limits": { "max_speed_pct": 60, "max_command_ms": 15000, "max_program_ms": 120000, "max_loop_ms": 60000 },
    "notes": []
  },
  "twin": {
    "unconfirmed": ["A", "B", "C", "D", "S1", "S2", "S3", "S4", "left_right", "front", "drive", "wheel_diameter", "axle_track"],
    "ev3": { "motors": { "B": "large", "C": "large" } },
    "view": { "drive": "wheels" }
  }
}
```

A port token stays listed until you know what is on that port, **also when you believe it is empty**: a port you could not see may hold a part.
`footprint` and `places` are not in the template because it has no `twin.body` and no places yet: add the token with the first length you assume.

## Parts

Add each one the robot has, on its confirmed port. A port nobody confirmed: the one rule is in [questions.md](questions.md) row 4; keep its token. `<X>` is a motor port `A`-`D`, `<n>` a sensor port `1`-`4`.

| Part | `twin.ev3` | `profile.roles` | Also |
|---|---|---|---|
| Large or medium motor that does not drive | `"motors": {"<X>": "large"}` or `"medium"` | a free name for what it does: `"arm": "ev3.<X>"` (`lift`, `gripper`, `head`, `wings`, `dial`) | a note: what it does, which way positive degrees move it, its range |
| Touch | `"sensors": {"<n>": "touch"}` | `"touch": "ev3.S<n>"` | none: the twin's touch is pressed when the whole front of the body is within 0.7 cm of a wall or a box |
| Colour | `"sensors": {"<n>": "color"}` | `"color": "ev3.S<n>"` | `twin.body.color_sensor_x_cm`, `color_spot_radius_cm` |
| Ultrasonic or infrared | `"sensors": {"<n>": "ultrasonic"}` or `"ir"` | `"distance": "ev3.S<n>"` | `twin.body.distance_sensor_x_cm` |
| Gyro | `"sensors": {"<n>": "gyro"}` | `"gyro": "ev3.S<n>"` | `"heading": {"device": "gyro", "channel": "angle_deg"}` in the drivetrain, only when the port is confirmed. Its place changes nothing in the physics |
| The brick (always) | none | none | `twin.view.brick`: `"pose"` `"flat"` or `"standing"`, `"screen"` `"front"` or `"back"` (flat: where ports A-D point; standing: where the screen faces), as the photo shows. A leaning brick: the closer pose and a note "the brick leans <n>° toward <the front / the back>" |
| Phone | none | none | `twin.view.phone`; a note "A phone stands at the front with its screen facing forward; it joins as a page and lends its camera, screen and speaker." (`<clone>/docs/manual.md` "Peripheral pages on a phone") |

`twin.view.sensors.<n>` (`x_cm`, `y_cm`, `z_cm`) places a sensor in the 3D look only. Leave out the body fields of a sensor the robot does not have.

A part whose kind is a guess: write the likelier kind on its port, keep the port's token, add a note "<port>: <kind a> or <kind b>, not confirmed", and ask the question naming both (SKILL.md state 1). Something plugged into a port whose kind you cannot even guess: a motor is `"large"` if it drives, else `"medium"`; a sensor gets no entry in `twin.ev3.sensors` and no role (the file has no "sensor of unknown kind"), the port's token, and a note "S<n>: a sensor is plugged in here, kind unknown". A part of an official model that the photo does not show is written like a seen one, with its token and a note "<part> on <port>: from the <model>'s build, not seen in the photo".

## A robot with no drive (an arm, a crane, a station, a controller)

Delete `pair`, `profile.drivetrain`, the wheel roles, `left_right`, `wheel_diameter` and `axle_track`. Every motor is a device; `drive`, `turn` and `arc` answer `unsupported`. Keep `drive` in `twin.unconfirmed` until you know it does not drive. The origin is the middle of the base on the floor; take the front by questions.md row 2 and say which end in `notes`.

## Coordinates

Every length is in cm from the centre of the drive axle, on the floor: `x` ahead, `y` to the left, `z` up. "Ahead" is where a positive `drive` goes. With several axles, the driven one; with tracks, the middle of the tracks.

## Every field

| Field | Allowed values | Default | What it is |
|---|---|---|---|
| `description` | text | none | for people only |
| `name` | 1-22 letters (accents too), digits, spaces, `'`, `.`, `-` | none: no name | what the person calls the robot: Claude speaks as it, the 3D page shows it as its title, the brick shows it on its screen. Only the person chooses it. To change it later, edit it here and restart Claude Code |
| `pair.left`, `pair.right` | two different ports of `A`-`D` | no `pair`: no drive | the drive motors, left and right seen from behind |
| `hardware.low_battery_v`, `max_tone_ms`, `tone_volume_pct` | number > 0 | required | 6.5, 5000, 50 fit the EV3 |
| `hardware.speech_volume_pct` | 1 to 100 | required on ev3dev | |
| `hardware.ir_channel` | 1-4 | 1 | the infrared remote's channel switch |
| `profile.id` | lowercase letter or digit first, then lowercase letters, digits, `_`, `-`; at most 44 characters | required | the twin is `<id>-sim` |
| `profile.roles.<name>` | `ev3.A`-`ev3.D`, `ev3.S1`-`ev3.S4`, `ev3.pair`, `sim.camera`, a page's device | `{}` | on a twin, a role on an empty port stops the start |
| `profile.drivetrain` | `type` `"differential"`, `pair_device` `"ev3.pair"`, `wheel_diameter_cm` > 0, `axle_track_cm` > 0, `forward_sign` 1 or -1, `max_drive_cm` > 0, `max_turn_deg` > 0, `heading?` | none: no drive tools | needs `pair` |
| `profile.limits.*` | numbers > 0 | required | `max_speed_pct`, `max_command_ms`, `max_program_ms`, `max_loop_ms` |
| `profile.notes` | array of text | required, may be `[]` | facts for the model the file has no field for |
| `twin.unconfirmed` | a list of tokens, each once: `A`-`D`, `S1`-`S4`, `left_right` (needs `pair`), `front`, `drive`, `wheel_diameter` and `axle_track` (need `drivetrain`), `footprint`, `places` | none: nothing unconfirmed | what nobody confirmed; the check prints it as the `draft` line |
| `twin.ev3.motors.<A-D>` | `"large"`, `"medium"` | nothing plugged | |
| `twin.ev3.sensors.<1-4>` | `"touch"`, `"color"`, `"ultrasonic"`, `"gyro"`, `"ir"` | nothing plugged | |
| `twin.body.front_cm`, `back_cm`, `half_width_cm` | number >= 0 | 8, 10, 6 | the footprint: a rectangle around the axle, used for collisions and the touch sensor |
| `twin.body.color_sensor_x_cm`, `color_spot_radius_cm` | number >= 0 | 7, 1 | where the colour sensor reads the floor, on the centre line |
| `twin.body.distance_sensor_x_cm` | number >= 0 | 8 | where the ultrasonic or infrared looks out, straight ahead on the centre line |
| `twin.view` | the fields in the header of `<clone>/apps/twin-view/src/look.ts`, nothing else | the default look | the 3D look only; a bad field draws its default, so check by eye in state 4. `twin.view.unconfirmed` is refused: the page gets the list from `twin.unconfirmed` |

## What a twin cannot have

For each row the robot hits: write the note, tell the person the line in their language, keep the rest of the file as the row says. Never leave it out in silence.

| On the real robot | In the file | Tell the person |
|---|---|---|
| An NXT light, sound or colour sensor, or another maker's sensor | nothing on that port, no role; a note with its port | "The twin has no <sensor>; on the real robot the model can still read it as `ev3.S<n>`." |
| An NXT touch or ultrasonic sensor | `"touch"` or `"ultrasonic"` | none |
| An NXT motor | `"large"`; a note | "The twin uses an EV3 large motor for the NXT motor." |
| An attachment: an arm, claw, lifter, turntable | the motor's role, `twin.view.motors.<X>.attachment` `"arm"`, `"gripper"`, `"lift"` or `"turntable"`, and a note on what it does and its range | "The 3D twin draws the <attachment> as a LEGO <arm / gripper / lift / turntable> of beams that moves with its motor." |
| Another attachment: a scoop, hammer, wings, a frame | the closest of those, else `"axle"`; a note | "The 3D twin draws the <attachment> as a <closest>, moving with its motor." |
| A bumper bar | `twin.view.bumper` | none |
| A shell, decoration or a tall body (a humanoid, an animal) | `twin.view.shell` `"panels"` or `"beams"`; a note | "The 3D twin draws <side panels / a frame of beams>, not the <shell>'s shape." |
| A brick leaning, neither flat nor upright | the closer `view.brick.pose`; a note | "The 3D twin shows the brick <flat / upright>." |
| No drive | as "A robot with no drive" | The stop: "This looks like the <model>: <what you see>, no wheels. The twin shows it standing on a frame of beams and turning its motors; it cannot drive. Is it the <model>?" (es: "Parece el <modelo>: <lo que ves>, sin ruedas. El gemelo lo muestra de pie sobre un marco de vigas, girando sus motores; no puede andar. ¿Es el <modelo>?") |
| Four or six wheels, two sides driven (or chained) | `differential`; `view.wheels_per_side` 2 or 3; the footprint covers every wheel; a note | "The twin drives as two sides; it draws <n> wheels a side turning together, without the gears or chain." |
| Front and rear axles driven by separate motors (the Stair Climber) | no `pair`, no drivetrain, `view.drive` `"none"`; each motor a role (`front_wheels`, `rear_wheels`, `lift`); a note | "The twin cannot drive or climb: it stands on a frame of beams and turns each motor on its own." |
| A caster, ball or skid; a frame or beam whose end rests on the floor | `back_cm` (or `front_cm`) reaches it; the resting frame is `view.caster` `"skid"`. The support at the end the brick rule calls the front: the front is the other end, `front` token kept | none |
| Steering (one motor steers, one drives), legs, a walker | no `pair` and no drivetrain; the motors as roles; a note | "The twin cannot steer or walk: its motors turn, the body stays put." |
| Two wheels and no caster: it balances | `differential`; `view.caster` `"none"`; a note "balances on two wheels; do not drive it without its balance program" | "The twin does not fall over; the real robot does without its balance program." |
| A motor turned by hand as a dial | role `dial`; a note | "In the twin nobody turns the dial; it reads what the program turns." |
| A sensor that faces sideways, up, behind, or sits off the centre line | the closest `x` in `twin.body`; its real place in `twin.view.sensors`; a note | "The 3D twin draws the <sensor> where it is, but it reads straight ahead (the floor) on the centre line." |
| Terrain (stairs, ramps, rough ground) | a note | "The twin's floor is flat." |
