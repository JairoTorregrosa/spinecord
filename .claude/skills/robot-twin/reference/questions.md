# Questions for the person, and what to assume without an answer

Send every open question in **one** message, numbered, in the person's language, each with its choices so the person can answer "1 b, 2 a, 3 12 cm". Leave out a question whose value is already confirmed (SKILL.md, "Confirm"). Ask the intake questions (photos, which robot) first and alone: their answer changes the rest.

No ruler? A LEGO beam is one: from the centre of one hole to the centre of the next is 0.8 cm, so "lay a beam along it and count the holes; each hole is 0.8 cm". A 15-hole beam is 12 cm long.

## Intake

The messages of SKILL.md state 0. Its deciding questions stop while unanswered; "Is this the <model>, built as in the instructions, with <attachment>?" on a readable photo does not: it goes first in this message.

A part whose kind is unsure: "Is the part at <place>, on port <X> if you can see it, a <kind a> (<its tell>) or a <kind b> (<its tell>)?" Its port keeps its token: the token covers the kind. Port not readable either: "a <kind a> or a <kind b>, and on which port?"

## The build

| # | Question | Choices | Token | Assumed without an answer |
|---|---|---|---|---|
| 1 | "Is the EV3 connected to this computer by USB, and switched on?" | yes / no | (the brick confirms every port) | no |
| 2 | "Which end is the front, the end it drives toward? Tip: a gripper, an arm or the distance sensor is usually at the front; a ball caster or skid usually behind." | (a) <one end, named by a part there> (b) <the other end> | `front` | **The one rule for the front**, first that applies: an official model, the end its build looks forward from (TRACK3R: the infrared end); the end with an attachment (gripper, arm, scoop, bumper) or a sensor looking ahead (distance, touch plunger); else the end away from a ball caster or skid (small free wheels under an attachment are not the caster); else from the brick: flat, the end with ports 1-4 (ports A-D to the back); standing, the end its screen faces |
| 3 | "Stand behind the robot, looking where it drives. Which motor port drives the LEFT wheel or track: the cable from the left motor goes into port …?" | A / B / C / D | `left_right` | the lower letter of the pair is the left |
| 4 | Per port you cannot read: "What is plugged into port <X>?" | nothing / large motor (long, round end) / medium motor (small, square) / touch / colour / gyro / ultrasonic / infrared / other | `A`-`D`, `S1`-`S4` | **The one rule for an assumed port:** the port the photo shows, even read with doubt; else, for the model itself, the port its build gives the part (identify.md "Reading a build"; on a model's base only the drive ports); else the drive pair on B (left) and C (right), and every other motor and sensor on the lowest free port of its row, in the order you list them (with a drive pair: A, then D; with no drive: A, B, C, D). A motor whose size you cannot tell (its length against the brick): `"large"` when it drives, `"medium"` when it does not; the token kept and the question naming both sizes |
| 5 | Per motor that does not drive: "What does the motor on <X> do (lift, gripper, arm, head, wings, a dial you turn by hand)? Which way does it move with positive degrees, and about how far?" | free | its port | a note: "the motor on <X> moves <what you see>; direction and range unknown" |
| 6 | "Does it drive on wheels, on tracks, or does it not drive at all?" | wheels / tracks / no drive | `drive` | what touches the floor in the photo |
| 7 | Wheels: "What is printed on the side of a tire (for example `56 x 28`)? Or which of these is it?" + the wheel rows of parts.md. Tracks: "Are the tracks one rubber band on small rims, or black plastic links over toothed wheels?" | the rows | `wheel_diameter` | the parts.md row that the photo matches best |
| 8 | "Measure from the middle of the left wheel to the middle of the right wheel (tracks: track middle to track middle), in cm." | a number | `axle_track` | the official model's; else from the photo with the brick as scale (identify.md "Scale"); else 12 |
| 9 | "How far does the robot reach ahead of the wheel axle, behind it (caster, skid, bumper), and how wide is it, in cm?" | three numbers | `footprint` | from the photo with a scale; else the package defaults (leave `twin.body`'s three lengths out) |
| 10 | "Does the brick lie flat, stand upright, or lean? Which way does its screen face (upright), or which end has ports A-D (flat): toward the front or the back?" | flat / upright / leaning; front / back | `places` | what the photo shows; else flat, ports A-D to the back (row 2's front) |
| 11 | Per sensor: "How far ahead of the wheel axle is it (negative if behind), how far left or right of the middle, how high, and which way does it look (ahead, down, up, sideways, back)?" | numbers; ahead / down / up / left / right / back | `places` | identify.md's default place of that sensor; the way its face points in the photo |
| 12 | "Is a phone on the robot? Where does it stand, how high is its bottom edge, which way does its screen face?" | none / numbers, front / back | `places` | none |
| 13 | "What is your robot called? You may leave it without a name." If `~/mi-robot/.spinecord-setup.json` has `name`, ask "Is it still <name>?" instead | free: 1-22 letters, digits, spaces, `'` `.` `-` | none | no name: leave `name` out; `profile.id` is `mi-robot` |
| 15 | "What holds the back up: (a) a steel ball, (b) a skid that slides, (c) small wheels that turn freely, (d) nothing, it balances?" | a / b / c / d | `places` | what the photo shows; `view.caster` `"ball"`, `"skid"`, `"wheel"` or `"none"` (parts.md) |
| 16 | A robot that climbs, walks or steers: "The twin cannot <climb / walk / steer>. Which motion should it show: (a) <motor X: what it does>, (b) …?" | the motors | none | each motor turning on its own (robot-file.md "What a twin cannot have") |
| 14 | Always last: "Is there anything the photo does not show: a sensor underneath or inside, another motor, a part behind the brick?" | no / yes: what, where, which port | the ports | the ports you could not see stay listed |

A value assumed here keeps its token in `twin.unconfirmed`. Write the question that would confirm it in the report.
