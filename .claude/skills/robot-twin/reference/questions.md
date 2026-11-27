# Questions for the person, and what to assume without an answer

Send every open question in **one** message, numbered, in the person's language, each with its choices so the person can answer "1 b, 2 a, 3 12 cm". Leave out a question whose value is already confirmed (SKILL.md, "Confirm"). Ask the intake questions (photos, which robot) first and alone: their answer changes the rest.

No ruler? A LEGO beam is one: from the centre of one hole to the centre of the next is 0.8 cm, so "lay a beam along it and count the holes; each hole is 0.8 cm". A 15-hole beam is 12 cm long.

## Intake (SKILL.md state 0)

- **Which robot.** "I see <n> robots: (a) <place, colour, wheels or tracks>, (b) … Which one is yours?"
- **More photos.** See identify.md "More photos" for which views to ask for.
- **A drawing or a render.** "This is <an instruction drawing / a render / a slide>. Please send a photo of the robot you built. If you built exactly this model, step for step, tell me its name."

## The build

| # | Question | Choices | Token | Assumed without an answer |
|---|---|---|---|---|
| 1 | "Is the EV3 connected to this computer by USB, and switched on?" | yes / no | (the brick confirms every port) | no |
| 2 | "Which end is the front, the end it drives toward? Tip: the colour or distance sensor usually looks ahead; a caster, skid or the cables usually hang behind." | (a) <one end, named by a part there> (b) <the other end> | `front` | the end the distance sensor looks out of, else the end opposite the caster or skid, else the end the brick's screen faces |
| 3 | "Stand behind the robot, looking where it drives. Which motor port drives the LEFT wheel or track: the cable from the left motor goes into port …?" | A / B / C / D | `left_right` | the lower letter of the pair is the left |
| 4 | Per port you cannot read: "What is plugged into port <X>?" | nothing / large motor (long, round end) / medium motor (small, square) / touch / colour / gyro / ultrasonic / infrared / other | `A`-`D`, `S1`-`S4` | identify.md: the part you can see, on the lowest free port of its row (motors B and C for the drive, then A, D; sensors 1 up) |
| 5 | Per motor that does not drive: "What does the motor on <X> do (lift, gripper, arm, head, wings, a dial you turn by hand)? Which way does it move with positive degrees, and about how far?" | free | its port | a note: "the motor on <X> moves <what you see>; direction and range unknown" |
| 6 | "Does it drive on wheels, on tracks, or does it not drive at all?" | wheels / tracks / no drive | `drive` | what touches the floor in the photo |
| 7 | "What is printed on the side of a tire (for example `56 x 28`)? Or which of these is it?" + the rows of parts.md | the rows | `wheel_diameter` | the parts.md row that the photo matches best (tracks: 4.0) |
| 8 | "Measure from the middle of the left wheel to the middle of the right wheel (tracks: track middle to track middle), in cm." | a number | `axle_track` | from the photo with the brick as scale (identify.md "Scale"); else 12 |
| 9 | "How far does the robot reach ahead of the wheel axle, behind it (caster, skid, bumper), and how wide is it, in cm?" | three numbers | `footprint` | from the photo with a scale; else the package defaults (leave `twin.body`'s three lengths out) |
| 10 | "Does the brick lie flat or stand upright? Which end of it has the screen and ports A-D: toward the front or the back?" | flat / upright; front / back | `places` | flat; the end you can see in the photo |
| 11 | Per sensor: "How far ahead of the wheel axle is it (negative if behind), how far left or right of the middle, how high, and which way does it look (ahead, down, up, sideways, back)?" | numbers; ahead / down / up / left / right / back | `places` | identify.md's default place of that sensor; the way its face points in the photo |
| 12 | "Is there a sensor or motor the photo does not show (under the brick, behind it)?" | no / yes: what and where | the ports | no |
| 13 | "Is a phone on the robot? Where does it stand, how high is its bottom edge, which way does its screen face?" | none / numbers, front / back | `places` | none |
| 14 | "What is your robot called?" | free | none | `mi-robot` |

A value assumed here keeps its token in `twin.unconfirmed`. Write the question that would confirm it in the report.
