---
name: robot-twin
description: Make the spinecord twin match the LEGO EV3 robot a person built. From photos of the robot, what a connected EV3 reports on each port, and a few measurements, it writes the person's robot file (ports, wheels or tracks, footprint, phone, look), checks it with --doctor, shows the twin in the 3D view, calibrates on the real robot and registers it in Claude Code. Use it when a person says "my robot", "match the twin to my robot", "here is a photo of my robot", "make the simulation look like my robot", "mi robot", "este es mi robot", "aquí está la foto de mi robot", "haz que el gemelo sea mi robot", "simula mi robot".
---

# Match the twin to the person's robot

You are a coding agent on the computer of a person who built a LEGO EV3 robot.
This file lives in the clone, at `<clone>/.claude/skills/robot-twin/`; its reference files are next to it. Claude Code started in the workshop folder does not load it by itself: the person asks you to read it.
spinecord is set up (skill `setup-spinecord`): a clone, and a workshop folder where Claude Code runs.
You write one robot file that is this robot, so that the twin (`<id>-sim`) is the same robot: the same ports, drive, footprint and look.
Talk to the person in the language the person uses. Keep commands, file names and JSON keys as written here.
In every line you run or hand the person, write `<clone>` and `~/mi-robot` as full paths of this computer (on Windows, `C:\Users\<name>\mi-robot`).

## Words

| Word | What it is |
|---|---|
| `<clone>` | the full path of the spinecord clone, for example `~/spinecord`. Find it: `claude mcp get spinecord` in the workshop folder shows `.../apps/local/main.ts` |
| workshop folder | `~/mi-robot`, outside the clone. Never write in the clone |
| robot file | `~/mi-robot/robot.json` |
| the brick | the EV3 itself, when it is connected to this computer |
| check | `bun <clone>/apps/local/main.ts --doctor --twin ~/mi-robot/robot.json`, always with `--twin` alone: read only its `robots` and `twin <id>-sim` lines |

## States

Start at the first state whose exit check fails. A new session resumes from what is on disk: when `~/mi-robot/robot.json` exists, states 1 and 2 are done and the file holds what state 1 found; read it and go to state 3.

| State | Exit check |
|---|---|
| 1 GATHER | You know, for each of ports A-D and 1-4, what is plugged in and what it does; wheels or tracks and their size; the axle track; the footprint; the front; a phone or none |
| 2 WRITE | `~/mi-robot/robot.json` exists |
| 3 CHECK | The check prints `ok    twin <id>-sim`, and that line matches state 1 |
| 4 SHOW | The person says the 3D twin matches the robot, or the differences left are ones a twin cannot have |
| 5 REGISTER | `claude mcp get spinecord` in the workshop folder shows `--twin` with the robot file |
| 6 CALIBRATE | `profile.notes` has a line that starts with `Calibrated`, or the person has no real robot to drive |
| 7 REPORT | The person has the report |

If a step fails 2 times, stop and show the person the exact error.

## 1 GATHER

Sources, best first. A later source never overrides an earlier one.

1. **The brick**, when the person has the EV3 here. Spinecord must be registered with `--ev3` and the EV3 `online` (setup skill state 8). The robot file it was registered with does not matter: the brick reports what is really plugged in. Call the MCP tool `list_robots`, then `describe_robot` on the robot whose source is `ev3`. Each `ev3.A`..`ev3.D` and `ev3.S1`..`ev3.S4` device is what is plugged in; map it with [reference/brick.md](reference/brick.md). It cannot see what a motor does or where things sit.
2. **The photos.** Ask for two: one from above, and one from the side, with a ruler or a 30 cm school ruler next to the robot if the person has one. Read them yourself. Find: wheels or tracks, the tire size printed on the tire wall, which ports have cables (the letters A-D are on the top edge of the brick, the numbers 1-4 on the bottom edge), sensors and their kind, a phone, the front. When the brick reported, use the photos only for what it cannot see.
3. **The person**, only for what neither shows. Ask one question at a time, in this order, and skip what you already know:
   1. "Which end is the front: the end it drives toward?"
   2. Without the brick: "Which port is each cable plugged into?" Then, per motor: "Is it a large motor (long, round end) or a medium motor (small, square)?"
   3. "Which motor drives the left side and which the right, looking from behind?"
   4. Per other motor: "What does the motor on <port> do (an arm, a gripper, a lift, a head that turns)? Which way does it move, and how far?"
   5. "Wheels or tracks?" Then offer the pick list of [reference/parts.md](reference/parts.md), or ask the person to measure the diameter with a ruler.
   6. "Measure from the middle of the left wheel to the middle of the right wheel, in cm." (tracks: from track middle to track middle)
   7. "Measure how far the robot reaches ahead of the wheel axle, behind it (a caster, a skid, a bumper), and how wide it is, in cm."
   8. "Where does the brick sit: over the axle, ahead of it or behind it, by how many cm? Which end does its screen face: the front or the back?"
   9. Per sensor: "How far ahead of the axle is it, and how high?" Per phone: "Where does it stand, how high is its bottom edge, and which way does its screen face?"

Write down each answer with its source (brick, photo, person). You need them in state 7.

## 2 WRITE

1. Read [reference/robot-file.md](reference/robot-file.md). Start from its template, or from the robot file in `<clone>/deployments/` closest to the robot (`deployments/orugas/robots/orugas.json` is a tracked build with a phone).
2. Read the header comment of `<clone>/apps/twin-view/src/look.ts` for the fields of `twin.view`.
3. Write `~/mi-robot/robot.json`. Every port in `twin.ev3`, every role, `pair`, the drive numbers from state 1, `twin.body`, `twin.view`.
4. Put in `profile.notes` what the model must know and the file has no field for: what each actuator does, which way and how far it moves, where each sensor looks, what the phone is for.
5. `profile.id`: a short name of the robot, lowercase, for example the name the person gave it.

## 3 CHECK

1. Run the check. It starts nothing and takes a few seconds.
2. Read the `robots` line and the `twin <id>-sim` line. The other lines check this computer, not the file: ignore them here.
3. A `fail` on `robots` names the file, the field and how to fix it. Fix the file and run the check again.
4. Compare the `twin` line with state 1: each port and its role, the pair, wheel and axle track, the footprint, the look's parts, and "build from the robot file's twin".

## 4 SHOW (human step)

1. Ask the person to open a new terminal and run this line there:

```sh
bun <clone>/apps/local/main.ts --twin ~/mi-robot/robot.json --view --view-port 8770
```

2. Tell the person: "Open http://127.0.0.1:8770/ in your browser. Compare the robot on the screen with your robot: wheels or tracks, where the brick, the motors, the sensors and the phone are, the size. Tell me what is different."
3. Fix the file for each difference, run the check, and ask the person to stop the line with Ctrl+C and run it again, then reload the page.
4. A difference the file cannot express (see "What a twin cannot have" in [reference/robot-file.md](reference/robot-file.md)): write it in `notes` and in the report.
5. Ask the person to stop the line with Ctrl+C when done.

## 5 REGISTER

1. In the workshop folder, run `bun <clone>/apps/local/main.ts --print-add --twin ~/mi-robot/robot.json --view`. Add, before `--view`:
   - with an EV3 on USB: `--ev3 ~/mi-robot/robot.json`;
   - with a phone on the robot: `--pages --lan`. The phone then joins robot `<id>` and lends its camera, screen and speaker: README "Peripheral pages on a phone" pairs it.
2. Take the first line it prints. Change `-s user` to `-s local`.
3. Run `claude mcp remove -s local spinecord` (a "not found" answer is fine), then the line.
4. Run `claude mcp get spinecord`: it shows `--twin` with the robot file.
5. Tell the person: "Close Claude Code and start it again in the workshop folder. Your robot is `<id>-sim` in the simulation, and `<id>` when the EV3 is connected. The 3D view is at http://127.0.0.1:8769/."

## 6 CALIBRATE (human step)

Skip it when there is no real robot to drive. It needs state 5, a new session, and the EV3 `online`.

1. Direction: "Put the robot on the floor with free space ahead." Call `drive` 5 cm. If it went backward, set `forward_sign` to -1, then state 5 step 5 again.
2. Distance: "Mark where the robot starts." Call `drive` 50 cm. "Measure how far it went, in cm." New `wheel_diameter_cm` = old × measured ÷ 50. Round to 0.01.
3. Turn: "Mark which way the robot faces." Call `turn` 360°. "How far did it turn: a full turn, more, or less? About how many degrees?" New `axle_track_cm` = old × 360 ÷ turned degrees. Round to 0.1. With `drivetrain.heading` (a gyro), the gyro ends the turn: skip this step unless the turn is off by more than 10°.
4. Write the new numbers into the robot file. Run the check. Ask the person to restart Claude Code, then repeat steps 2 and 3 once.
5. When the robot drives 50 cm within 1 cm and turns 360° within 5°, add a note: `Calibrated <date>: drive 50 cm went <x> cm, turn 360° turned <y>°.`
6. The twin uses the same numbers, so on the twin the same calls drive 50 cm and turn 360° (the room's noise aside). When the real robot now does that too, they match.

## 7 REPORT

```text
Robot file: ~/mi-robot/robot.json (id <id>, twin <id>-sim)
Ports: <port: part, role> for each port (source: brick / photo / person)
Drive: <wheels or tracks>, wheel <d> cm, axle track <t> cm, forward_sign <s> (calibrated: yes / no)
Footprint: <front> ahead, <back> behind, <width> wide; phone: <where, screen> / none
Not in the twin: <what the twin cannot have, or none>
Registered: <robot flags>; start Claude Code again in ~/mi-robot
```

## Rules

- The brick beats a photo, a photo beats a guess. Never invent a port: ask.
- Never edit files in the clone. Only `~/mi-robot/robot.json`.
- Never run a long-lived server yourself: the person runs state 4's line in a terminal of their own.
- A move of the real robot only after the person says the floor is clear.
