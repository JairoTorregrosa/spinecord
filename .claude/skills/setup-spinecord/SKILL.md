---
name: setup-spinecord
description: Set up spinecord from zero on macOS, Windows or Linux for a person who is not a developer, also from the Code tab of the Claude desktop app with no terminal. The person picks who pays - their Claude app plan, or Claude API credits in a Console organization. Installs git, bun, Claude Code and, for credits, the ant CLI with `ant auth login` (no API key), clones spinecord, registers it in the folder mi-robot, and ends with Claude driving the robot - the twin in a 3D view, or a LEGO EV3 over USB. Resumes from any state. Also does the later asks - a new name for the robot, adding an EV3, repairing spinecord when it stops working. Use it when a person asks to set up spinecord, to install the robot tools, to prepare a computer for a robot workshop or an EV3, or says "call the robot Rayo", "llama al robot Rayo", "ponle Rayo a mi robot", "cámbiale el nombre al robot", "I have an EV3 now", "ya tengo un EV3", "ya tengo el EV3", "conecté el EV3", "spinecord does not work", "spinecord no funciona", "arregla spinecord".
---

# Set up spinecord

You are the agent on the computer of a person who wants Claude to drive a robot.
The person is not a developer. Talk to the person in their language, in short sentences. Keep commands as written.
The end: Claude Code moves the robot while the person looks. Without an EV3, the robot is a twin in a 3D page. In the Claude desktop app, the person never leaves the app and never types a command.

## Files

Read a file only when a step names it. They are next to this file, also in the copy in `~/mi-robot/.claude/skills/setup-spinecord/`.
Before the clone exists, read them at `https://raw.githubusercontent.com/JairoTorregrosa/spinecord/main/.claude/skills/setup-spinecord/<file>`.

| File | When |
|---|---|
| install.md | States TOOLS and CLONE: the install commands of each OS |
| fixes.md | A check fails: one row for each known problem |
| see-it.md | State SEE IT: start the robot's Claude Code for each path, and what the person sees |
| facts.md | A step and the computer disagree: the facts, their sources and what is not verified |
| robots.json | The robots that the workshop registers. Change only this file to use other robots |

`setup <step>` in this file means this command, in any shell, from either copy: `cd ~/spinecord; bun scripts/setup.ts <step>`.
If this session installed a tool, put the `PATH` line of install.md for this OS first in the same command.
Each `setup` line is `ok`, `warn`, `todo` or `fail`, the reason, and after `->` the next action. The last line is `setup <step>: ok` or `setup <step>: not done`.
`setup status` changes nothing. Its last line `next <STATE>` names the state to do.

## Rules

- The person acts only in the steps marked PERSON. Do all other steps yourself.
- Before a PERSON step, say what the person will see and what to click. Then wait for the step to end.
- Never ask for, show or write a key, a token or an email. Never run `ant auth print-credentials`.
- Never put `ANTHROPIC_PROFILE` in a settings file: Claude Code ignores it there. Never register spinecord with user scope. Never start the robot's Claude Code in the clone.
- Before `sudo`, say why. Change a shell profile only as install.md says, after the approval of the plan.
- Give every command a timeout of 10 minutes. Every step is safe to run again.
- If the same step fails 2 times, stop. Show the error line and the row of fixes.md, in the person's language.
- On Windows, use PowerShell for all commands.
- Only one robot session runs spinecord. Before you start one, check: `list_robots` answers in this session, or the line `SEE IT` of `setup status` names a server. Never drive the robot with `claude -p`. Each request starts and stops a server, and the 3D page loses its link.

## Start: three questions and one approval

1. Do the detect step of TOOLS. If the clone exists, also run `setup status`.
2. Send the person one message with these four parts. Then wait for the answer.
   - "Who pays for Claude? 1: the plan of your Claude app login (Pro or Max). 2: the Console API credits of the workshop." "1 uses your plan's limits, and needs no other sign-in. 2 uses the credits, and needs one sign-in in the browser."
   - "Do you have a LEGO EV3 robot with you? Without one, Claude drives a robot on the screen."
   - "What is the name of your robot? This is optional."
   - The plan: the missing tools by name, the folders `~/spinecord` and `~/mi-robot`. On macOS and Linux, also one line in `~/.zshrc` or `~/.bashrc`. Ask for one yes.
3. Remember the answers. With answer 1, do not install `ant`. State CHOOSE records the payer, state WORKSHOP the rest.
4. After each state, show the progress list. Mark the states that are done. With answer 1, leave out 4 and 5:

```text
[x] 1 Tools  [x] 2 Download  [ ] 3 Who pays  [ ] 4 Sign in  [ ] 5 Credits pay  [ ] 6 Robot folder
[ ] 7 Test   [ ] 8 See it move   [ ] 9 EV3 (only with an EV3)   [ ] 10 Report
```

## States

Do the first state that is not done. To resume once the clone exists, run `setup status` and do the state that its line `next` names. It shows only the states of the chosen path.

| # | State | Done when |
|---|---|---|
| 1 | TOOLS | `git --version`, `bun --version` (1.3.14 or later), `claude --version` and, for credits, `ant --version` print versions |
| 2 | CLONE | `setup status` prints its lines, and its last line starts with `next` |
| 3 | CHOOSE | `setup status` shows `CHOOSE` `ok` |
| 4 | LOGIN | Credits only: `setup status` shows `LOGIN` `ok` |
| 5 | PAYS | Credits only: `setup status` shows `PAYS` `ok` or `warn` |
| 6 | WORKSHOP | `setup workshop` ends with `setup workshop: ok`, after the line `doctor: ok` |
| 7 | SMOKE | `setup status` shows `SMOKE` `ok` |
| 8 | SEE IT | `setup status` shows `SEE IT` `ok`. Only `setup confirm moved` records it; the move itself is not recorded |
| 9 | EV3 | `setup status` shows `EV3` `ok` |
| 10 | REPORT | The person has the report |

### 1 TOOLS

Detect: run the 4 `--version` commands. Install only what fails, as install.md says for this OS.
Exit check: the 4 commands print versions in this session.

### 2 CLONE

Do the section Clone of install.md. It clones, or updates a clone that exists, and installs the packages.

### 3 CHOOSE

Answer 1 of the start: run `setup choose app`. Answer 2: run `setup choose credits`. The person can change it later.

### 4 LOGIN (PERSON, in the browser)

If `setup status` shows `LOGIN` `ok`, the profile has a login: go to state 5.
Say this first, in the person's language:
"A browser page of platform.claude.com opens now. Sign in with the email that received the credits. If it asks for an organization, click the one with the credits. Then click Authorize, and come back here."
Then, at once, run `setup login`. It opens the browser and waits up to 5 minutes for the person.
Exit check: `setup login: ok`. Else use fixes.md.

### 5 PAYS (PERSON answers one question)

Run `setup status`. Read the line `PAYS`. It uses the environment of a new terminal, not of this session. Its `host` and `session` parts are only notes.
If it says `todo` with an organization name, ask the person: "Claude will use the credits of "<name>". Is that the organization with your credits?"
If yes, run `setup confirm org`. If no, use the row "Wrong Console organization" of fixes.md.
If it says `todo` with only an organization id, ask the person to compare it with the id at platform.claude.com, Settings, Organization. If it is the organization with the credits, run `setup confirm org`. If it is another one, or the person cannot find the id, use the row "Wrong Console organization" of fixes.md.
If it says `fail`, use the row of fixes.md that it names after `->`.

### 6 WORKSHOP

Run `setup workshop --ev3 yes` or `setup workshop --ev3 no`, from the answer of the start.
If the person gave a name, add `--name "<name>"` to that command. The name stays when you run the step again.
It makes `~/mi-robot`, allows the spinecord tools there, copies the skills there (line `skills`), registers spinecord with local scope, and runs the doctor.
A doctor `warn` line does not stop this state. For a `fail` line, use fixes.md, then run the same command again.

### 7 SMOKE

Run `setup smoke`. One `claude -p` request drives the twin 5 cm, for at most USD 0.50. It needs no person.
Show the person the answer and the cost from the `smoke` line. If a server already runs, it skips the request.

### 8 SEE IT (PERSON)

Do the part of see-it.md for the chosen path. It starts the robot's Claude Code, then `setup view` waits for it.
Then say: "In the 3D page you see the robot in a room. Type: Drive forward 30 cm, then turn left 90 degrees."
Ask: "Did the robot move on the page?" If yes, run `setup confirm moved`. If no, use fixes.md.

### 9 EV3 (PERSON)

Skip this state if the person has no EV3. The person keeps the robot's Claude Code of state 8 open.

1. Say:
   - "Turn on the EV3. Connect it to this computer with the USB cable."
   - "In Chrome or Edge, open http://127.0.0.1:8767/. Click Connect EV3 (the page is in English). In the window, click the EV3, then Connect. Keep that tab open."
   - "Put the robot on the floor with free space in front of it. In Claude Code, type: list the robots, then drive the EV3 forward 5 cm."
2. Ask: "Does the answer say the EV3 is online? Did the robot move forward or backward?"
3. Not online: use the row "EV3 not `online`" of fixes.md.
4. Forward: run `setup confirm forward`.
5. Backward: run `setup flip`. Start the robot's Claude Code again, as its `restart` line says. Do steps 1 and 2 again.

### 10 REPORT

Run `setup report`. Give the person its lines, in their language. Add what the person must still do, if anything.
Running the skill again changes nothing and ends here.

## Later asks

The person asks for one of these after the setup, often in the robot's Claude Code in `~/mi-robot`. There, this session's spinecord holds its ports: while `list_robots` answers, a `port` `fail` that names them is expected. Do not tell the person about it. A registration change is read only at start. Then do what the `restart` line says.

| The person says | Do | Done when | Restart |
|---|---|---|---|
| A new name: "Call the robot Rayo", "llama al robot Rayo", "ponle Rayo a mi robot" | `setup name "<name>"`, or `setup name none` for no name. It registers and runs no doctor. A `fail` line: do the action after `->` | `setup name` ends `ok`. Its `restart` line says what the person does next | Yes. The next start shows the name |
| "I have an EV3 now", "ya tengo un EV3" | `setup workshop --ev3 yes`. After the restart, run `setup status` and do state 9 EV3 | `setup status` shows `EV3` `ok` | Yes, before state 9 |
| "spinecord does not work. Run its doctor and fix it", "spinecord no funciona" | `setup workshop` runs the doctor. Fix each `fail` line with fixes.md, except the expected `port` lines. Then do the state that `setup status` names after `next` | After the restart: `setup workshop: ok`, and `setup status` ends `next REPORT` | Yes, after the fixes |
