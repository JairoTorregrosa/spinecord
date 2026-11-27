---
name: robot-twin
description: Make the spinecord twin match the LEGO EV3 robot a person built. From photos of the robot, what a connected EV3 reports on each port, and the person's answers, it writes the person's robot file (ports, wheels or tracks, footprint, phone, look), marks what nobody confirmed, checks it, shows the twin in the 3D view, calibrates on the real robot and registers it in Claude Code. It stops and says why when the photo is not of one EV3 robot the person built. Use it when a person says "my robot", "match the twin to my robot", "here is a photo of my robot", "make the simulation look like my robot", "mi robot", "este es mi robot", "aquí está la foto de mi robot", "haz que el gemelo sea mi robot", "simula mi robot".
---

# Match the twin to the person's robot

You are a coding agent on the computer of a person who built a LEGO EV3 robot. spinecord is set up (skill `setup-spinecord`).
You write one robot file, so that the twin `<id>-sim` is that robot: its ports, drive, footprint and look. What nobody confirmed stays listed in the file as unconfirmed, never passed off as known.
Talk to the person in the language the person uses. Keep commands, file names and JSON keys as written here. Write `<clone>` and `~/mi-robot` as full paths of this computer.

| Word | What it is |
|---|---|
| `<clone>` | the spinecord clone. `claude mcp get spinecord` in the workshop folder shows `<clone>/apps/local/main.ts`. This file is `<clone>/.claude/skills/robot-twin/SKILL.md` |
| robot file | `~/mi-robot/robot.json`. Never write in the clone |
| the brick | the EV3 on USB, with spinecord registered with `--ev3` and the robot `online` (skill `setup-spinecord`, its EV3 state). Which robot file it was registered with does not matter: the brick reports what is plugged in |
| the person | someone who answers you in this session. When you were told that nobody will answer, or the person says to go on without questions, there is no person |
| check | `bun <clone>/apps/local/main.ts --doctor --files-only --twin ~/mi-robot/robot.json`. It reads only the file: exit 0 means the file is valid |
| token | an entry of `twin.unconfirmed`: `A`-`D`, `S1`-`S4`, `left_right`, `front`, `drive`, `wheel_diameter`, `axle_track` change how the robot moves; `footprint`, `places` change only the look and collisions |

## Outcomes

- **stop**: no file is written; you tell the person why and what you need (state 0).
- **draft twin**: a valid file whose `twin.unconfirmed` is not empty. Tell the person: "This is a draft twin: <the draft line of the check> are guesses. Answer these questions or connect the brick, and I will confirm them." with the questions.
- **twin**: a valid file with `twin.unconfirmed` empty or absent.

## States

Start at the first state whose exit check fails. If `~/mi-robot/robot.json` exists, states 0-2 are done: read it; if its `twin.unconfirmed` lists a token and a person or the brick is here, go to state 1 for those tokens only, else go to state 3. If a step fails 2 times, end there and show the person the exact error.

| State | Exit check |
|---|---|
| 0 INTAKE | The photos show one assembled EV3 robot that the person built, with its drive and brick readable; or the outcome is **stop** |
| 1 GATHER | Every row of the table "Confirm" has a value and a source (brick, photo, person or assumed) |
| 2 WRITE | The robot file exists, and `twin.unconfirmed` lists exactly the tokens whose source is assumed |
| 3 CHECK | The check prints `twin <id>-sim` matching state 1, and the draft gate below passes |
| 4 SHOW | The person says the 3D twin matches, or the differences left are in "What a twin cannot have"; skipped with no person |
| 5 REGISTER | `claude mcp get spinecord` in the workshop folder shows `--twin` with the robot file; skipped with no person |
| 6 CALIBRATE | `profile.notes` has a line that starts with `Calibrated`, or there is no real robot to drive |
| 7 REPORT | The person has the report |

## 0 INTAKE

Read [reference/identify.md](reference/identify.md), "What the photo shows". Classify each photo before you read any detail. The first row that matches decides; only the last row writes a file. Recognising the problem and building anyway is the failure this state exists to prevent.

| The photo shows | Say (in the person's language), then |
|---|---|
| No robot, or a slide, poster, screen, box art, render or instruction drawing | "This is <a slide / an instruction drawing / …>, not a photo of the robot you built. Please send a photo of your robot, from above and from the side. If you built exactly this model, step for step, tell me its name." **stop**. Only a yes to that last question goes on, with every value from the drawing assumed |
| A non-EV3 brick (NXT, SPIKE, Robot Inventor, RCX, …) and no EV3 | "This robot is built on a <NXT / SPIKE Prime / …> (<the tell you saw>). spinecord drives LEGO EV3 bricks only, so I cannot make its twin. If you also have an EV3 robot, send me a photo of it." **stop** |
| An EV3 robot beside robots of another kind | "I see <what each is>. Only <the EV3 one> runs on an EV3. Is that your robot?" **stop** until a yes |
| Several EV3 robots | "I see <n> robots: (a) <place, colour, wheels or tracks>, (b) … Which one is yours?" **stop** until an answer |
| One EV3 robot whose brick or drive (wheels, tracks, none) is hidden, cropped or blurred | "I can see <what you see>, but not <what is hidden>. Please send <the views of identify.md "More photos">." **stop** until the photos or the brick come |
| One EV3 robot, readable | Go on |

**stop** writes no file and ends at state 7 with that message as the report. With no person, a **stop** is final; with a person, their answer or new photos start state 0 again.

**Official model.** When the robot looks like a model of identify.md "Official models" (the Education Driving Base, TRACK3R, Gyro Boy, …), add to the first questions: "Is this the <model>, built as in the instructions, with <attachments>?" A yes makes its row's ports and geometry source person; with no person they are the assumed values, tokens kept.

## 1 GATHER

Sources, best first; a later source never overrides an earlier one.

1. **The brick.** Call `list_robots`, then `describe_robot` on the robot whose source is `ev3`; map each port with [reference/brick.md](reference/brick.md). It confirms what is on each port, not what it does or where it sits.
2. **The photos.** Read them with [reference/identify.md](reference/identify.md): name each part (its LEGO part number where identify.md has it), where it sits, the scale. A part's kind comes from its tells; when two kinds fit (a part seen from behind, a colour sensor or a touch sensor), the kind is assumed and asked, never picked. One photo is enough to start; each value it cannot settle is assumed.
3. **The person.** Everything still unconfirmed, in one message, from [reference/questions.md](reference/questions.md). Ask again only for what the answers left open. "I don't know" keeps the value assumed.
4. **Assumed.** With no source left, take the value questions.md gives for it (one rule per value; for a port, row 4), and write its token. Never take a port, a side or a number from an example file.

### Confirm

| Value | Token | Confirmed by | Not by |
|---|---|---|---|
| What is on each port (and, for a motor that does not drive, what it does) | `A`-`D`, `S1`-`S4` | the brick; the person; a photo where the port's label is legible and its cable can be followed to the part, or its socket is visibly empty | a port you cannot read; a kind you chose between two |
| Which pair motor drives the left side, seen from behind | `left_right` | the person; state 6 | a photo |
| Which end is the front | `front` | the person; state 6 | a photo |
| Wheels, tracks, or no drive | `drive` | a photo showing what touches the floor; the person | |
| Wheel diameter | `wheel_diameter` | the size printed on the tire, legible; a row of parts.md the person picks; a measurement; state 6 | a row you picked by eye |
| Axle track | `axle_track` | the person's measurement; state 6 | |
| Footprint (`twin.body` lengths) | `footprint` | the person's measurement; a photo with a ruler beside the robot | a length scaled from a part (identify.md "Scale"): use it, keep the token |
| Where the brick, sensors and phone sit | `places` | the person; a photo with a ruler | the same |

Keep each value with its source: state 7 needs them.

## 2 WRITE

1. Read [reference/robot-file.md](reference/robot-file.md) and the header comment of `<clone>/apps/twin-view/src/look.ts` (the fields of `twin.view`; it changes).
2. Copy the template. It arrives with every token in `twin.unconfirmed`. Fill each value from state 1; take a token out only when its row of "Confirm" has a source other than assumed.
3. Add each sensor and actuator from robot-file.md "Parts". Delete what the robot does not have.
4. In `profile.notes`: what each actuator does and its range, where each sensor looks, what the phone is for, and one line per row of "What a twin cannot have" that this robot hits. Tell the person those rows now, before any twin is shown (a balancer, a stair climber, an arm that the 3D view draws on wheels).
5. `name`: the name the person gave the robot (questions.md row 13), as they wrote it; with no name, leave `name` out. Never make one up. `profile.id`: that name in lowercase, accents dropped, spaces as `-`; with no name, `mi-robot`.

## 3 CHECK

1. Run the check. A `fail` on `robots` names the field and the fix: fix the file and run it again.
2. Compare the `twin <id>-sim` line with state 1: each port and role, the pair, wheel and axle track, the footprint, the look.
3. **Draft gate.** A `draft <id>-sim` line lists the tokens left. For each one that changes how the robot moves: if a source of its "Confirmed by" is here (the brick, the person) and you have not used it for that token yet, go back to state 1 for it. A token only state 6 can confirm waits for state 6. No token left: the outcome is **twin**. Tokens left: the outcome is **draft twin**; tell the person so now, and with no person go to state 7.

## 4 SHOW (human step)

1. Ask the person to run, in a new terminal: `bun <clone>/apps/local/main.ts --twin ~/mi-robot/robot.json --view --view-port 8770`
2. "Open http://127.0.0.1:8770/. Compare the robot on the screen with yours: wheels or tracks, where the brick, motors, sensors and phone are, the size. Tell me what is different."
3. Fix the file for each difference, run the check, ask the person to stop the line (Ctrl+C), run it again and reload the page.
4. A difference the file cannot show: robot-file.md "What a twin cannot have". Write it in `notes`, tell the person in one line.
5. Ask the person to stop the line when done.

## 5 REGISTER

1. In the workshop folder: `bun <clone>/apps/local/main.ts --print-add --twin ~/mi-robot/robot.json --view`, adding before `--view`: `--ev3 ~/mi-robot/robot.json` with an EV3 on USB; `--pages --lan` with a phone on the robot (README "Peripheral pages on a phone").
2. Take its first line, change `-s user` to `-s local`. Run `claude mcp remove -s local spinecord` ("not found" is fine), then that line.
3. `claude mcp get spinecord` shows `--twin` with the robot file.
4. "Close Claude Code and start it again in the workshop folder. Your robot is `<id>-sim` in the simulation, `<id>` with the EV3 connected. The 3D view is at http://127.0.0.1:8769/."

## 6 CALIBRATE (human step)

Needs state 5, a new session, the EV3 `online`, and the person saying the floor is clear. Skip every move that is unsafe or meaningless for the build, and say so: a robot that balances on two wheels (it falls when driven without its balance program), a build with no drive, a stair climber off its stairs.

1. Front and sides: "Put the robot on the floor with free space ahead." Call `drive` 5 cm. Backward: set `forward_sign` to -1. Then `turn` 90°: it must turn left (counter-clockwise from above). It turned right: swap `pair.left` and `pair.right`. Take `front` and `left_right` out of `twin.unconfirmed`. Do state 5 step 4 again.
2. Distance: `drive` 50 cm; "How far did it go, in cm?" `wheel_diameter_cm` = old × measured ÷ 50, round to 0.01.
3. Turn: `turn` 360°; "How far did it turn?" `axle_track_cm` = old × 360 ÷ turned degrees, round to 0.1. With `drivetrain.heading` (a gyro) skip this unless it is off by more than 10°.
4. Write the numbers, take `wheel_diameter` and `axle_track` out of `twin.unconfirmed`, run the check, ask the person to restart Claude Code, repeat steps 2 and 3 once.
5. Within 1 cm and 5°: add the note `Calibrated <date>: drive 50 cm went <x> cm, turn 360° turned <y>°.`

## 7 REPORT

```text
Outcome: stop / draft twin / twin
Robot file: ~/mi-robot/robot.json (id <id>, twin <id>-sim)   (stop: none, and why)
Ports: <port: part, role, source> for each port
Drive: <wheels / tracks / none>, wheel <d> cm, axle track <t> cm, forward_sign <s> (calibrated: yes / no)
Unconfirmed: <the draft line of the check, or none>
Not in the twin: <rows of "What a twin cannot have", or none>
Questions for the person: <the open questions of questions.md, in one message, or none>
Registered: <robot flags> / not yet
```

## Rules

- The brick beats a photo, a photo beats an assumption, and an assumption is always a token in `twin.unconfirmed`.
- Only `~/mi-robot/robot.json` is written; never files in the clone.
- Never run a long-lived server yourself: the person runs state 4's line.
- The real robot moves only after the person says the floor is clear.
