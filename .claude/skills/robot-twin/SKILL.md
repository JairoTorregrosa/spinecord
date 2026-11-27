---
name: robot-twin
description: Make the spinecord twin match the LEGO EV3 robot a person built. From photos of the robot, what a connected EV3 reports on each port, and the person's answers, it writes the person's robot file (ports, wheels or tracks, footprint, phone, look), marks what nobody confirmed, checks it, shows the twin in the 3D view, calibrates on the real robot and registers it in Claude Code. It stops and says why when the photo is not of one EV3 robot the person built. Use it when a person says "my robot", "match the twin to my robot", "here is a photo of my robot", "make the simulation look like my robot", "mi robot", "este es mi robot", "aquí está la foto de mi robot", "haz que el gemelo sea mi robot", "simula mi robot".
---

# Match the twin to the person's robot

You are a coding agent on the computer of a person who built a LEGO EV3 robot. spinecord is set up (skill `setup-spinecord`).
You write one robot file, so that the twin `<id>-sim` is that robot: its ports, drive, footprint and look. What nobody confirmed stays listed in the file as unconfirmed, never passed off as known.
Talk to the person in the language the person uses. Each message in quotes here is the English source: say it in the person's language, keep its meaning and its question marks, never add a second question. Keep commands, file names and JSON keys as written here. Write `<clone>` and `~/mi-robot` as full paths of this computer.

| Word | What it is |
|---|---|
| `<clone>` | the spinecord clone. `claude mcp get spinecord` in the workshop folder shows `<clone>/apps/local/main.ts`. This file is `<clone>/.claude/skills/robot-twin/SKILL.md`, or its copy in `~/mi-robot/.claude/skills/robot-twin/` (the setup's `workshop` step copies it); `<clone>` is found the same way from both |
| robot file | `~/mi-robot/robot.json`. Never write in the clone |
| the brick | the EV3 on USB, with spinecord registered with `--ev3` and the robot `online` (skill `setup-spinecord`, its EV3 state). Which robot file it was registered with does not matter: the brick reports what is plugged in |
| the person | someone who answers you in this session. When you were told that nobody will answer, or the person says to go on without questions, there is no person |
| check | `bun <clone>/apps/local/main.ts --doctor --files-only --twin ~/mi-robot/robot.json`. It reads only the file: exit 0 means the file is valid |
| the map | `<clone>/packages/lego-parts/data/`: the real parts and the official builds (`builds.json`). Read a build as identify.md "Reading a build" says |
| token | an entry of `twin.unconfirmed`: `A`-`D`, `S1`-`S4`, `left_right`, `front`, `drive`, `wheel_diameter`, `axle_track` change how the robot moves; `footprint`, `places` change only the look and collisions |

## Outcomes

- **stop**: no file is written; you tell the person why and what you need (state 0). A stop keeps its question open: it is never answered by an assumption.
- **draft twin**: a valid file whose `twin.unconfirmed` is not empty. Tell the person: "This is a draft twin: <the draft line of the check> are guesses. Answer these questions or connect the brick, and I will confirm them." with the questions.
- **twin**: a valid file with `twin.unconfirmed` empty or absent.

## States

Start at the first state whose exit check fails. If `~/mi-robot/robot.json` exists, states 0-2 are done: read it; if its `twin.unconfirmed` lists a token and a person or the brick is here, go to state 1 for those tokens only, else go to state 3. If a step fails 2 times, end there and show the person the exact error.

| State | Exit check |
|---|---|
| 0 INTAKE | The photos show one assembled EV3 robot that the person built, with its drive and brick readable (identify.md "Readable"), and every deciding question is answered; or the outcome is **stop** |
| 1 GATHER | Every row of the table "Confirm" has a value and a source (brick, photo, person, model or assumed; model counts as assumed unless the person said yes to the model) |
| 2 WRITE | The robot file exists, and `twin.unconfirmed` lists exactly the tokens whose source is assumed |
| 3 CHECK | The check prints `twin <id>-sim` matching state 1, and the draft gate below passes |
| 4 SHOW | The person says the 3D twin matches, or the differences left are in "What a twin cannot have"; skipped with no person |
| 5 REGISTER | `claude mcp get spinecord` in the workshop folder shows bun's full path and `--twin` with the robot file; skipped with no person |
| 6 CALIBRATE | `profile.notes` has a line that starts with `Calibrated`, or there is no real robot to drive |
| 7 REPORT | The person has the report |

## 0 INTAKE

Read [reference/identify.md](reference/identify.md), "What the photo shows", "Readable" and "Official models". Classify each photo with "What the photo shows" before you read any detail. The first row that matches decides; only the last two rows write a file. Recognising the problem and building anyway is the failure this state exists to prevent.

| The photo shows | Say, then |
|---|---|
| A picture of an official model you recognise ("What the photo shows": not a photo) | "This is <an instruction drawing / …> of the <model>, <its attachment or variant>, not a photo of a robot you built. Did you build exactly this, step by step? If yes, I can start from its instructions; either way, a photo of your robot from above and from the side helps." (es: "Esto es <un dibujo de instrucciones / …> del <modelo>, <su accesorio>, no una foto de un robot que tú armaste. ¿Armaste exactamente esto, paso a paso? Si sí, puedo partir de sus instrucciones; en todo caso, me sirve una foto de tu robot desde arriba y de lado.") **stop**, deciding question open |
| Tells of a photo and of a picture of an official model at once ("What the photo shows") | "Is this a photo of the robot you built, or a picture of the <model> from the box, the instructions or the web?" **stop**, deciding question open; asked once |
| Any other picture that is not a photo, or no robot | "This is <a slide / an instruction drawing / …>, not a photo of the robot you built. Please send a photo of your robot, from above and from the side." **stop** |
| EV3 parts not built into a robot (a brick, loose motors, a wheel), alone or beside another robot | "I see EV3 parts that are not built into a robot yet<, beside a <the other robot>>. When your robot is built, send me a photo of it from above and from the side." **stop** |
| A non-EV3 brick (identify.md "Not an EV3" decides), and no EV3 | "This robot is built on a <NXT / SPIKE Prime / …> (<the tell you saw>). spinecord drives LEGO EV3 bricks only, so I cannot make its twin. If you also have an EV3 robot, send me a photo of it." (es: "Este robot está armado sobre un <NXT / SPIKE Prime / …> (<la señal que viste>). spinecord solo maneja ladrillos LEGO EV3, así que no puedo hacer su gemelo. Si también tienes un robot EV3, mándame una foto de él.") **stop** |
| A robot whose brick is not readable (a shell, blur, out of frame), with no tell of "Not an EV3" and no EV3 part seen (a red-hub motor, an EV3 sensor) | "I can see <what you see>, but not the brick it is built on. Please send <the views of identify.md "More photos">, one with the brick's ports." **stop** |
| An EV3 robot beside robots of another kind | "I see <what each is>. Only <the EV3 one> runs on an EV3. Is that your robot?" **stop**, deciding question open |
| Several EV3 robots | "I see <n> robots: (a) <place, colour, wheels or tracks>, (b) … Which one is yours?" (es: "Veo <n> robots: (a) <lugar, color, ruedas u orugas>, (b) … ¿Cuál es el tuyo?") **stop**, deciding question open |
| One EV3 robot whose brick or drive is not readable, and it is not an official model you recognise | "I can see <what you see>, but not <what is hidden>. Please send <the views of identify.md "More photos">." **stop** |
| One EV3 robot whose brick or drive is not readable, and it is an official model you recognise (identify.md "Official models") | "This looks like the <model> <with …>, but I cannot see <what is hidden>. Is it exactly that model? Or send <the views of identify.md "More photos">." **stop**, deciding question open |
| One EV3 robot, readable, an official model or built on a model's base | Go on with the model (below) |
| One EV3 robot, readable | Go on |

**Deciding questions.** Only these stop while unanswered: "Is this your robot?", "Which robot is yours?", "Did you build exactly this model?" (a picture that is not a photo), "Is this a photo of the robot you built?", and "Is it exactly this model?" when the brick or the drive cannot be read otherwise. Every other open question, "Is this the <model>?" on a readable photo included, lets a **draft twin** through with its tokens. With no person a deciding question stays open: the outcome is **stop**, never a file built on the likely answer. With a person, the answer or new photos start state 0 again. **stop** writes no file and ends at state 7 with that message as the report.

**Official model.** identify.md "Official models" decides between the model, a robot on a model's base, and a custom robot. A yes to "did you build exactly this" or "is it exactly this model" makes the model's build the source of the robot. Otherwise the model's values are assumed, and "Is this the <model>, built as in the instructions, with <attachments>?" goes first in the state 1 message. In state 1 the build gives (identify.md "Reading a build"); on a model's base, only the drive:
- the ports the photo does not show: every fixed port of the build, the hidden ones too (a gyro inside Gyro Boy is in the file, source "model", its token kept); an `attachment:` port only when that attachment is seen or named. A port read from the photo keeps the photo's part (identify.md "Where a port is"); a port of the build that is visibly empty in the photo is not the model's: the question says so ("The <model> uses B and C; in your photo the cables go into A and B and C is empty. Are the wheels on A and B?");
- its wheel diameter and axle track, assumed (tokens kept until state 6). An axle track wider than the footprint read from the photo: the photo wins, `axle_track_cm` is the footprint width minus one wheel or track width (the check prints a `footprint` warn until then);
- its notes: balancing, steering, walking, no drive.
A person's yes to the model confirms the ports whose kind the build names and the ports it leaves empty (take their tokens out); the questions then shrink to what the instructions do not fix: the attachment, ports a person may have changed, the name, a phone.

## 1 GATHER

Sources, best first; a later source never overrides an earlier one.

1. **The brick.** Call `list_robots`, then `describe_robot` on the robot whose source is `ev3`; map each port with [reference/brick.md](reference/brick.md). It confirms what is on each port, not what it does or where it sits.
2. **The photos.** Read them with [reference/identify.md](reference/identify.md): name each part (its LEGO part number where identify.md has it), where it sits, the scale. A part's kind comes from its tells; when two kinds fit (a part seen from behind, a colour sensor or a touch sensor), write the likelier one, keep its port's token, and ask a question that names both. One photo is enough to start; each value it cannot settle is assumed.
3. **The person.** Everything still unconfirmed, in one message, from [reference/questions.md](reference/questions.md). Ask again only for what the answers left open. "I don't know" keeps the value assumed.
4. **The model** (only for an official model, state 0): the build's values for what the photo does not show, assumed unless the person said yes to the model.
5. **Assumed.** With no source left, take the value questions.md gives for it (one rule per value; for a port, row 4), and write its token. Never take a port, a side or a number from an example file.

### Confirm

| Value | Token | Confirmed by | Not by |
|---|---|---|---|
| What is on each port: the part's kind, and for a motor that does not drive what it does | `A`-`D`, `S1`-`S4` (the token covers the kind: a kind you guessed keeps its port's token) | the brick; the person; the person's yes to an official model, for the ports whose kind its build names; a photo where the port's label is legible and its cable can be followed to the part, or its socket is visibly empty (identify.md "Where a port is") | a port you cannot read; a kind you chose between two |
| Which pair motor drives the left side, seen from behind | `left_right` | the person; state 6 | a photo |
| Which end is the front | `front` | the person; state 6 | a photo |
| Wheels, tracks, or no drive | `drive` | a photo showing what touches the floor; the person | |
| Wheel diameter | `wheel_diameter` | the size printed on the tire, legible; a row of parts.md the person picks; a measurement; state 6 | a row you picked by eye |
| Axle track | `axle_track` | the person's measurement; state 6 | |
| Footprint (`twin.body` lengths) | `footprint` | the person's measurement; a photo with a ruler beside the robot | a length scaled from a part (identify.md "Scale"): use it, keep the token |
| Where the brick, sensors and phone sit, and the brick's pose (flat, standing, tilted) | `places` | the person; a photo with a ruler | the same; always write the pose (robot-file.md "Parts") |

Keep each value with its source: state 7 needs them.

## 2 WRITE

1. Read [reference/robot-file.md](reference/robot-file.md) and the header comment of `<clone>/apps/twin-view/src/look.ts` (the fields of `twin.view`; it changes).
2. Copy the template. It arrives with every token in `twin.unconfirmed`. Fill each value from state 1; take a token out only when its row of "Confirm" has a source other than assumed (a model the person did not confirm is assumed).
3. Add each sensor and actuator from robot-file.md "Parts". Delete what the robot does not have.
4. In `profile.notes`: what each actuator does and its range, where each sensor looks, what the phone is for, and one line per row of "What a twin cannot have" that this robot hits. Tell the person those rows now, before any twin is shown (a balancer, a stair climber, a station with no drive).
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

1. In the workshop folder, `claude mcp get spinecord`: keep its `Args` after `apps/local/main.ts` (the setup's `--world`, `--view`, `--pages --lan`). Replace the path after `--twin` with the robot file (add `--twin <file>` when there is none); with an EV3 on USB, the same for `--ev3`.
2. `bun <clone>/apps/local/main.ts --print-add <those args>`. Take its first line, change `-s user` to `-s local`, and replace the word `bun` after `--` with bun's full path, in double quotes: `bun -e "console.log(process.execPath)"` prints it (a new terminal may not have bun on its PATH).
3. Run `claude mcp remove -s local spinecord` ("not found" is fine), then that line. `claude mcp get spinecord` shows that full path and `--twin` with the robot file.
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
Questions for the person: <the open questions of questions.md, in one message, or none; a stop's deciding question first>
Registered: <robot flags> / not yet
```

## Rules

- The brick beats a photo, a photo beats an assumption, and an assumption is always a token in `twin.unconfirmed`.
- Only `~/mi-robot/robot.json` is written; never files in the clone.
- Never run a long-lived server yourself: the person runs state 4's line.
- The real robot moves only after the person says the floor is clear.
