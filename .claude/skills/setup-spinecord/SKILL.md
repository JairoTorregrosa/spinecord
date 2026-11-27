---
name: setup-spinecord
description: Set up spinecord from zero on macOS, Windows or Linux for a person who is not a developer and who received Claude API credits in a Console organization. Installs git, bun, the ant CLI and Claude Code, logs in with `ant auth login` so that the credits pay (no API key), clones spinecord, registers it in the folder mi-robot, and ends with Claude driving the robot - the simulated twin in a 3D view in the browser, or a LEGO EV3 over USB. Resumes from any state. Use it when a person asks to set up spinecord, to install the robot tools, or to prepare a computer for a robot workshop or an EV3.
---

# Set up spinecord

You are the agent on the computer of a person who wants Claude to drive a robot.
The person is not a developer. Talk to the person in their language, in short sentences. Keep commands as written.
The end: Claude Code moves the robot while the person looks. Without an EV3, the robot is a twin in a 3D page.

## Files

Read a file only when a step names it. They are next to this file.
Before the clone exists, read them at `https://raw.githubusercontent.com/JairoTorregrosa/spinecord/main/.claude/skills/setup-spinecord/<file>`.

| File | When |
|---|---|
| install.md | States TOOLS and CLONE: the install commands of each OS |
| fixes.md | A check fails: one row for each known problem |
| facts.md | A step and the computer disagree: the facts, their sources and what is not verified |
| robots.json | The robots that the workshop registers. Change only this file to use other robots |

`setup <step>` in this file means this command, in any shell: `cd ~/spinecord; bun scripts/setup.ts <step>`.
If this session installed a tool, put the `PATH` line of install.md for this OS first in the same command.
Each `setup` line is `ok`, `todo` or `fail`, the reason, and after `->` the next action. The last line is `setup <step>: ok` or `setup <step>: not done`.
`setup status` changes nothing. Its last line `next <STATE>` names the state to do.

## Rules

- The person acts only in the steps marked PERSON. Do all other steps yourself.
- Before a PERSON step, say what the person will see and what to click. Then wait for the step to end.
- Never ask for, show or write a key, a token or an email. Never run `ant auth print-credentials`.
- Never put `ANTHROPIC_PROFILE` in a settings file. Claude Code ignores it there.
- Never register spinecord with user scope. Never start the robot's Claude Code in the clone.
- Before `sudo`, say why. Change a shell profile only as install.md says, after the approval of the plan.
- Give every command a timeout of 10 minutes. Every step is safe to run again.
- If the same step fails 2 times, stop. Show the error line and the row of fixes.md, in the person's language.
- On Windows, use PowerShell for all commands.

## Start: two questions and one approval

1. Do the detect step of TOOLS. If the clone exists, also run `setup status`.
2. Send the person one message with these three parts. Then wait for the answer.
   - "Do you have a LEGO EV3 robot with you? Without one, Claude drives a robot on the screen."
   - "What is the name of your robot? This is optional. Without a name, the robot has no name."
   - The plan: the missing tools by name, the folders `~/spinecord` and `~/mi-robot`, one sign-in in the browser. Ask for one yes.
   - On macOS and Linux, the plan also names one line in `~/.zshrc` or `~/.bashrc` for new terminals.
3. Remember the EV3 answer and the name. State WORKSHOP needs them.
4. After each state, show the person the progress list. Mark the states that are done:

```text
[x] 1 Tools   [x] 2 Download   [ ] 3 Sign in   [ ] 4 Credits pay   [ ] 5 Robot folder
[ ] 6 Test    [ ] 7 See it move   [ ] 8 EV3 (only with an EV3)   [ ] 9 Report
```

## States

Do the first state that is not done. To resume once the clone exists, run `setup status` and do the state that its line `next` names.

| # | State | Done when |
|---|---|---|
| 1 | TOOLS | `git --version`, `bun --version` (1.3.14 or later), `ant --version`, `claude --version` each print a version |
| 2 | CLONE | `setup status` prints its lines, and its last line starts with `next` |
| 3 | LOGIN | `setup status` shows `LOGIN` `ok` |
| 4 | PAYS | `setup status` shows `PAYS` `ok` |
| 5 | WORKSHOP | `setup workshop` ends with `setup workshop: ok`, after the line `doctor: ok` |
| 6 | SMOKE | `setup status` shows `SMOKE` `ok` |
| 7 | SEE IT | `setup status` shows `SEE IT` `ok` |
| 8 | EV3 | `setup status` shows `EV3` `ok` |
| 9 | REPORT | The person has the report |

### 1 TOOLS

Detect: run the 4 `--version` commands. Install only what fails, as install.md says for this OS.
Exit check: the 4 commands print versions in this session.

### 2 CLONE

Do the section Clone of install.md. It clones, or updates a clone that exists, and installs the packages.

### 3 LOGIN (PERSON, in the browser)

If `setup status` shows `LOGIN` `ok`, the profile has a login: go to state 4.
Say this first, in the person's language:
"A browser page of platform.claude.com opens now. Sign in with the email that received the credits. If it asks for an organization, click the one with the credits. Then click Authorize, and come back here."
Then, at once, run `setup login`. It opens the browser and waits up to 5 minutes for the person.
Exit check: `setup login: ok`. Else use fixes.md.

### 4 PAYS (PERSON answers one question)

Run `setup status`. Read the line `PAYS`.
If it says `todo` with an organization name, ask the person: "Claude will use the credits of "<name>". Is that the organization with your credits?"
If yes, run `setup confirm org`. If no, use the row "Wrong Console organization" of fixes.md.
If it says `todo` with only an organization id, run `setup confirm org` and ask nothing. State SMOKE shows if the credits pay.
If it says `fail`, use the row of fixes.md that it names after `->`.

### 5 WORKSHOP

Run `setup workshop --ev3 yes` or `setup workshop --ev3 no`, from the answer of the start.
If the person gave a name, add `--name "<name>"` to that command. The name stays when you run the step again.
It makes `~/mi-robot`, allows the spinecord tools there, registers spinecord there with local scope, and runs the doctor.
A doctor `warn` line does not stop this state. For a `fail` line, use fixes.md, then run the same command again.

### 6 SMOKE

Run `setup smoke`. One `claude -p` request drives the twin 5 cm, for at most USD 0.50. It needs no person.
Show the person the answer and the cost from the `smoke` line.

### 7 SEE IT (PERSON)

1. Run `setup report`. Take the launch line from its last line `Start Claude Code with:`.
2. Say this, with the launch line, in the person's language:
   - "Open a new terminal window. Paste this line and press Enter: <launch line>"
   - "Claude Code shows a color theme, then security notes. Press Enter at each."
   - "Then it asks if you trust the folder. Press the down arrow to Yes, I trust this folder, then Enter."
3. Then, at once, run `setup view`. When the person's Claude Code runs, it opens the 3D page in the browser.
4. If `setup view` ends `not done`, ask what the terminal shows, use fixes.md, and run it again.
5. Say: "In the browser you see the robot in a room. In the new Claude Code, type: Drive forward 30 cm, then turn left 90 degrees."
6. Ask: "Did the robot move on the page?" If yes, run `setup confirm moved`. If no, use fixes.md.

### 8 EV3 (PERSON)

Skip this state if the person has no EV3. The person keeps the Claude Code of state 7 open.

1. Say:
   - "Turn on the EV3. Connect it to this computer with the USB cable."
   - "In Chrome or Edge, open http://127.0.0.1:8767/. Click Connect EV3. In the window, click the EV3, then Connect. Keep that tab open."
   - "Put the robot on the floor with free space in front of it. In Claude Code, type: list the robots, then drive the EV3 forward 5 cm."
2. Ask: "Does the answer say the EV3 is online? Did the robot move forward or backward?"
3. Not online: use the row "EV3 not `online`" of fixes.md.
4. Forward: run `setup confirm forward`.
5. Backward: say "Type /exit in Claude Code." Then run `setup flip`. Then ask for the launch line again, and do steps 1 and 2 again.

### 9 REPORT

Run `setup report`. Give the person its lines, in their language. Add what the person must still do, if anything.
Running the skill again changes nothing and ends here.

## Later: a new name for the robot

The person asks for a new name, for example "ponle Rayo a mi robot".
1. Run `setup name "<name>"`. To remove the name, run `setup name none`.
2. If its line is `fail`, do the action after `->`.
3. Say: "Type /exit in Claude Code. Then paste the launch line again." The next start shows the new name.
