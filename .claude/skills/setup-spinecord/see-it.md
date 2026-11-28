# See the robot move

State SEE IT starts the robot's Claude Code in `~/mi-robot`. Then `setup view` waits for its 3D page.
Do only the part of the path that `setup status` shows in its line `CHOOSE`.
Write `~/mi-robot` as the full path of this computer. The line `spinecord` of `setup report` shows it.

First check that no robot session runs. If this session has the spinecord tools and `list_robots` answers, go to "Open the 3D page".

## App login (`setup choose app`)

The robot's Claude Code is this session. It moves to `~/mi-robot`, and the person talks to the robot in this chat.

1. Say: "I now move this chat to the folder mi-robot. If the app asks, allow the folder."
2. Call the tool `change_directory` of the app (`mcp__ccd_directory__change_directory`). Set `path` to the full path of `~/mi-robot`.
3. The move happens when your answer ends. So end your answer now with: "Send me one message, for example: ok."
4. In the next message, call `list_robots`. It names the twin `<id>-sim`. Then do "Open the 3D page".
5. No spinecord tools after the move: use the row "No spinecord tools after the move" of fixes.md.

No tool `change_directory`, or it refuses the move: the person starts a new session in `~/mi-robot`.

- In the Claude desktop app, say: "Click New session in the Code tab. Choose the folder mi-robot with the folder button."
- In a terminal agent, say: "Open a new terminal. Paste this line and press Enter:" with `cd ~/mi-robot` and then `claude`.
- Then run `setup view`, and do "Open the 3D page". The person talks to the robot in the new session.

## Credits (`setup choose credits`)

The Claude desktop app reads no `ant` profile. Only the command `claude` in a terminal does.
So the robot's Claude Code runs in a terminal with `ANTHROPIC_PROFILE`, and the person types the orders there.
You start that terminal yourself. The person never types the launch line.

1. Run `setup report`. Its line `Terminal panel of the Claude app` names the folder and the line for the panel.
2. If this session has the tool `run_in_terminal` of the app (`mcp__terminal__run_in_terminal`), use the Terminal panel:
   - Call it with `cwd` set to the full path of `~/mi-robot`, and the check command below.
   - macOS and Linux: `ANTHROPIC_PROFILE=credits claude auth status --text`. Windows: `$env:ANTHROPIC_PROFILE = 'credits'; claude auth status --text`.
   - Read the tab with `read_terminal`. Use the profile of `setup report` in place of `credits`.
   - It shows a line `Profile:` with the profile: call `run_in_terminal` again in that tab, with the line for the panel.
   - It shows `Login method:` instead: the panel has the login of the app. Close the tab with `stop_terminal_tab`. Do step 3.
3. With no Terminal panel, run `setup window`. A new terminal window opens and runs the launch line.
4. Say this to the person, in their language. The screens of Claude Code are in English.
   - "Claude Code starts in a terminal. Click in the terminal first."
   - "It shows a color theme. Press Enter. Then it shows security notes. Press Enter."
   - "Then it asks if you trust the folder. It says the folder pre-approves 1 tool permission, mcp__spinecord."
   - "That permission is the robot tool, so the folder is safe. The first answer, No, is selected."
   - "Press the down arrow until Yes, I trust this folder is selected. Then press Enter."
5. At once, run `setup view`. It waits for the robot's session, and prints a `wait` line every 10 seconds.
6. If it ends `not done`, read the terminal with `read_terminal`, or ask what the window shows. Use fixes.md, then run `setup view` again.
7. Say: "Type your orders in the terminal of Claude Code, not in this chat. Keep it open: the robot stops when it closes."

## Open the 3D page

1. Run `setup view`. It ends `ok`, with `already running` or `started`.
2. In the Claude desktop app, open `http://127.0.0.1:8769/` in the Browser pane of the app.
   - Use the tool `navigate` of the server `Claude_Browser`, or `preview_start` with `url`.
   - With no such tool, say: "Press Cmd+Shift+B on macOS, or Ctrl+Shift+B on Windows. Open http://127.0.0.1:8769/ there."
3. Outside the app, `setup view` opens the page in the default browser.
