---
name: setup-spinecord
description: Set up spinecord from zero on macOS, Windows or Linux for a person who received Claude API credits in a Console organization. Installs git, bun, the ant CLI and Claude Code, logs in with `ant auth login` so that the credits pay (no API key), clones spinecord, registers it in Claude Code in a workshop folder, runs `--doctor`, and drives the twin. Use it when a person asks to set up spinecord, to install the robot tools, or to prepare a computer for an EV3.
---

# Set up spinecord from zero

## Context

You are an agent on the computer of a person who wants to drive a robot with Claude Code.
The person is not a developer of spinecord.
The person received Claude API credits in a Console organization.
spinecord is an MCP server that runs on this computer and lets Claude drive a LEGO EV3 or its simulated twin.
You install the tools, log in to the Console organization, register spinecord and prove that it works on the twin.
The credits of the Console organization pay for Claude Code. Nobody makes or copies an API key.
Talk to the person in the language that the person uses. Keep commands and file names as written here.

## Words

| Word | What it is |
|---|---|
| the person | the human at this computer |
| Console organization | the organization on platform.claude.com that holds the credits |
| profile | an `ant` login, stored by name. This skill uses the name `spinecord` |
| the clone | the folder `spinecord` that `git clone` makes, in the home folder of the person |
| workshop folder | the folder `mi-robot` in the home folder of the person, outside the clone |
| launch line | the command that starts Claude Code in the workshop folder with the profile |
| the twin | the simulated robot `r1-sim`. It needs no hardware |
| human step | a step that only the person can do, in a browser or with the robot |

## Verified facts

Each fact has its source and the date of the check. Use only these facts in the steps.

| Fact | Source | Checked |
|---|---|---|
| `ant` 2.13.0 is the current release, with zip files for macOS and Windows and `.tar.gz`, `.deb` and `.rpm` files for Linux | https://github.com/anthropics/anthropic-cli/releases | 2026-11-24 |
| macOS: `brew install anthropics/tap/ant` | https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart | 2026-11-24 |
| Linux: the release `.tar.gz` file, extracted to a folder on `PATH` | https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart | 2026-11-24 |
| Windows: `winget install Anthropic.Ant`, a portable zip package of the same release | https://github.com/microsoft/winget-pkgs/tree/master/manifests/a/Anthropic/Ant | 2026-11-24 |
| `ant auth login` opens the browser. `--no-browser` prints the URL. `--profile <name>` makes that profile and makes it active | https://platform.claude.com/docs/en/cli-sdks-libraries/cli/authentication | 2026-11-24 |
| A profile keeps its organization for later logins. For another organization, log in with a new profile name | https://platform.claude.com/docs/en/cli-sdks-libraries/cli/authentication | 2026-11-24 |
| `ant auth status` prints `Logged in to <organization> as <email>`, the `Config dir:` path and the first characters of the token | `ant` 2.12.1 on macOS | 2026-11-24 |
| The profiles live in `ANTHROPIC_CONFIG_DIR`, else `~/.config/anthropic` (macOS, Linux), else `%APPDATA%\Anthropic` (Windows) | https://platform.claude.com/docs/en/manage-claude/wif-reference | 2026-11-24 |
| `ANTHROPIC_PROFILE` in the environment makes Claude Code use that profile, above a claude.ai login | https://code.claude.com/docs/en/authentication | 2026-11-24 |
| With no `ANTHROPIC_PROFILE`, a claude.ai login pays ahead of the active profile | https://code.claude.com/docs/en/authentication | 2026-11-24 |
| A profile name that does not exist makes Claude Code use the claude.ai login, with no error | Claude Code 2.1.331 on macOS | 2026-11-24 |
| `ANTHROPIC_PROFILE` in the `env` of `.claude/settings.json` or `.claude/settings.local.json` does not change who pays | Claude Code 2.1.331 on macOS, `/status` | 2026-11-24 |
| `claude auth status --text` prints `Profile: ... profile <name>` and `Organization:` when a profile pays, and `Login method:` for a claude.ai login | Claude Code 2.1.331 on macOS | 2026-11-24 |
| Claude Code: `curl -fsSL https://claude.ai/install.sh \| bash` (macOS, Linux), `irm https://claude.ai/install.ps1 \| iex` (PowerShell) | https://code.claude.com/docs/en/setup | 2026-11-24 |
| bun: `curl -fsSL https://bun.com/install \| bash` (macOS, Linux, needs `unzip`), `powershell -c "irm bun.sh/install.ps1\|iex"` (Windows) | https://bun.sh/docs/installation | 2026-11-24 |
| spinecord needs bun 1.3.14 or later, and git | README.md of the clone | 2026-11-24 |
| git: `brew install git` or `xcode-select --install` (macOS), `winget install --id Git.Git -e --source winget` (Windows) | https://git-scm.com/install/mac, https://git-scm.com/install/windows | 2026-11-24 |

Not verified, so not in the steps: the location of the profiles that Claude Code reads on native Windows.
The fix table gives the exit for that case.

## States

Go through the states in this order. Go to the next state only when the exit check of this state passes.

| State | Exit check |
|---|---|
| 1 PREFLIGHT | You know the OS, the shell, and the version of git, bun, `ant`, `claude` and the browser |
| 2 INSTALL | `git --version`, `bun --version` (1.3.14 or later), `ant --version` and `claude --version` each print a version |
| 3 CONSOLE LOGIN | `ant auth status` shows `Logged in to <organization>`, the person confirms the name, and `models list` exits 0 |
| 4 CLAUDE CODE PAYS | `claude auth status --text` with the profile shows `Profile:` and the same organization |
| 5 SPINECORD | The clone, the install, the workshop folder and the registration exist |
| 6 DOCTOR | The last line of `--doctor` is `doctor: ok` |
| 7 SMOKE TEST | One request on the twin drives 5 cm, and you know the cost |
| 8 EV3 OVER USB | `list_robots` shows the EV3 `online`, and the direction check passes. Skip this state if the person has no EV3 |
| 9 REPORT | The person has the report |

If the same step fails 2 times, stop. Show the error and the row of the fix table that matches it.

## Steps

### 1 PREFLIGHT

1. Find the OS: macOS, Windows or Linux.
2. Find the shell: zsh, bash or PowerShell. On Windows, use PowerShell for all commands.
3. Run `git --version`, `bun --version`, `ant --version` and `claude --version`.
4. Record the version of each tool, or "not found".
5. On macOS, look for `/Applications/Google Chrome.app` and `/Applications/Microsoft Edge.app`.
6. On Windows, look for `chrome.exe` and `msedge.exe` under `Program Files` and `Program Files (x86)`.
7. On Linux, run `command -v google-chrome microsoft-edge`.
8. Show the person a list of names and versions only. Do not show paths, variables or other output.

### 2 INSTALL

1. Make a list of the tools that state 1 did not find, and of a bun older than 1.3.14.
2. If the list is empty, go to state 3.
3. Show the list and the commands to the person. Ask for approval, then install.
4. Install one tool at a time. Run `<tool> --version` after each install.
5. On Windows, after each install, tell the person to close the terminal and open a new one.
6. On Windows, after a new terminal opens, run `<tool> --version` again.
7. If a new terminal does not find a tool, use the row "PATH after an install" of the fix table.

git:

1. On macOS with Homebrew, run `brew install git`.
2. On macOS without Homebrew, run `xcode-select --install`. Tell the person to click Install in the window that opens.
3. On Windows, run `winget install --id Git.Git -e --source winget`.
4. On Debian or Ubuntu, run `sudo apt install git unzip`. Tell the person that `sudo` installs system packages and asks for the password.

bun:

1. On macOS or Linux, run `curl -fsSL https://bun.com/install | bash`.
2. Tell the person that this installer adds a `PATH` line to the shell profile. Ask for approval first.
3. On Windows, run `powershell -c "irm bun.sh/install.ps1|iex"`.
4. If bun is older than 1.3.14, run `bun upgrade`.

ant:

1. On macOS, run `brew install anthropics/tap/ant`.
2. On Windows, run `winget install Anthropic.Ant`.
3. On Linux, download the release file to `~/.local/bin`, with no `sudo`:

```sh
VERSION=2.13.0
ARCH=$(uname -m | sed -e s/x86_64/amd64/ -e s/aarch64/arm64/)
mkdir -p ~/.local/bin
curl -fsSL "https://github.com/anthropics/anthropic-cli/releases/download/v${VERSION}/ant_${VERSION}_linux_${ARCH}.tar.gz" | tar -xz -C ~/.local/bin ant
```

4. On Linux, if `~/.local/bin` is not on `PATH`, use the row "PATH after an install" of the fix table.

Claude Code:

1. On macOS or Linux, run `curl -fsSL https://claude.ai/install.sh | bash`.
2. On Windows, run `irm https://claude.ai/install.ps1 | iex`.
3. Do not start `claude` for a login. State 3 and state 4 give Claude Code its login.

### 3 CONSOLE LOGIN (human step)

1. Tell the person what comes next, in these words or in the language of the person:
   - "A browser page of platform.claude.com opens."
   - "Sign in with the email that received the credits."
   - "If the page asks for an organization, click the organization with the credits."
   - "If the page asks for a workspace, click the default workspace."
   - "Click Authorize, then come back to this terminal."
2. Run `ant auth login --profile spinecord`.
3. If the computer has no browser, run `ant auth login --profile spinecord --no-browser`.
4. With `--no-browser`, give the person the URL. Tell the person to paste the code into the terminal.
5. Run `ant --profile spinecord auth status`. Read only the line that starts with `Logged in to`.
6. Take the organization name from that line. It is the text between `Logged in to` and the last ` as `.
7. Show the person the organization name only. Do not show the email, the token or other lines.
8. Ask the person: "Is this the organization with the credits?"
9. If the person says no, use the row "Wrong Console organization" of the fix table.
10. Run `ant --profile spinecord models list`. Do not show its output. Read only the exit code.
11. If the exit code is not 0, run step 2 again.

Exit check: the person confirmed the organization name, and `models list` exited 0.

### 4 CLAUDE CODE PAYS WITH THE CONSOLE ORGANIZATION

Claude Code takes the profile only from the environment of the terminal that starts it.
A settings file does not do it. Do not put `ANTHROPIC_PROFILE` in a settings file.

1. Check which of these variables have a value: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`.
2. Also check `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` and `CLAUDE_CODE_USE_ANTHROPIC_AWS`.
3. Show the names of the variables that have a value. Never show a value.
4. If a variable in that list has a value, use the row "Another credential pays" of the fix table.
5. Run the check that fits the shell, and show only the lines it keeps.

macOS or Linux:

```sh
ANTHROPIC_PROFILE=spinecord claude auth status --text | grep -E '^(Profile|Organization|Login method):'
```

Windows PowerShell:

```powershell
$env:ANTHROPIC_PROFILE = "spinecord"; claude auth status --text | Select-String '^(Profile|Organization|Login method):'
```

6. If the output has a line `Profile:` that ends with `profile spinecord`, compare the organization.
7. Take the text between `Organization:` and ` · `. It must be the organization of state 3.
8. If the output has a line `Login method:`, a claude.ai login pays. Stop, and use the row "Another credential pays".
9. If the output has no `Profile:` line on Windows, use the row "Windows profile folder" of the fix table.

The launch line for the person:

| Shell | Launch line |
|---|---|
| macOS or Linux | `cd ~/mi-robot && ANTHROPIC_PROFILE=spinecord claude` |
| Windows PowerShell | `cd $HOME\mi-robot; $env:ANTHROPIC_PROFILE = "spinecord"; claude` |

10. Tell the person to start Claude Code with the launch line in each new terminal.
11. If the person wants the variable in each terminal, ask for approval of a change to the shell profile.

Exit check: `Profile:` names `spinecord`, and the organization is the one that the person confirmed.

### 5 SPINECORD

1. Ask for approval to clone into the home folder, install, make `mi-robot` and register spinecord there.
2. In the home folder, run `git clone https://github.com/JairoTorregrosa/spinecord`.
3. In the clone, run `bun install --filter @spinecord/local`.
4. If the person wants the assistant example, run `bun install --filter @spinecord/local --filter @spinecord/assistant-example`.
5. Make the folder `mi-robot` in the home folder. Do not make it inside the clone.
6. In `mi-robot`, write the file `.claude/settings.json` with this text:

```json
{ "permissions": { "allow": ["mcp__spinecord"] } }
```

7. In `mi-robot`, run `bun <clone>/apps/local/main.ts --print-add --twin`. Write the full path of the clone for `<clone>`.
8. Take the first line that it prints. Change `-s user` to `-s local`. Do not change other text.
9. Run that line in `mi-robot`.

Use local scope for these reasons:

- Only sessions that start in `mi-robot` start a spinecord server.
- A Claude Code session in another folder opens no link to the robot.
- With `--ev3`, a second session cannot hold port 8767.
- With an EV3 on ev3dev, a second link can stop the motors during a move of the first session.

Exit check: in `mi-robot`, `claude mcp get spinecord` shows `Scope:` with the word `Local`.

### 6 DOCTOR

1. In `mi-robot`, run `bun <clone>/apps/local/main.ts --doctor --twin`.
2. Add `--ev3` if the person has an EV3 with stock firmware on USB.
3. Add `--pages` if the person lends a camera, a microphone or a screen through a browser page.
4. Add `--assistant` if the person uses the assistant example. Then set `ANTHROPIC_PROFILE=spinecord` in the same command.
5. Read each line. A line is `ok`, `warn` or `fail`, the reason, and after `->` the fix.
6. For each `fail` line, show the line to the person. Ask for approval, then run the fix.
7. If a fix names `bun apps/local/main.ts`, write the full path of the clone, and run it in `mi-robot`.
8. If a fix names `-s user`, write `-s local`.
9. Run the doctor again. Repeat until the last line is `doctor: ok`.

Exit check: the last line is `doctor: ok`.

### 7 SMOKE TEST

1. In `mi-robot`, run one request on the twin with the profile and a limit of USD 0.50.

macOS or Linux:

```sh
ANTHROPIC_PROFILE=spinecord claude -p "List the robots. Then drive r1-sim forward 5 cm. Answer in one line." --max-budget-usd 0.50 --output-format json
```

Windows PowerShell:

```powershell
$env:ANTHROPIC_PROFILE = "spinecord"; claude -p "List the robots. Then drive r1-sim forward 5 cm. Answer in one line." --max-budget-usd 0.50 --output-format json
```

2. Read `result`, `is_error` and `total_cost_usd` from the JSON. Do not show other fields.
3. If `is_error` is true, find the error text in the fix table.
4. Show the person the answer and the cost in USD.

Exit check: the answer names `r1-sim` and a move of 5 cm, and you know the cost.

### 8 EV3 OVER USB (human step)

Skip this state if the person has no EV3 with stock firmware.

1. In `mi-robot`, run `claude mcp remove -s local spinecord`.
2. Run `bun <clone>/apps/local/main.ts --print-add --ev3 --twin`. Change `-s user` to `-s local`, then run the line in `mi-robot`.
3. Run the doctor with `--ev3 --twin`, as in state 6, until `doctor: ok`.
4. Tell the person these steps:
   - "Turn on the EV3. Connect it to this computer with the USB cable."
   - "Open a new terminal. Type the launch line and press Enter."
   - "In Chrome or Edge, open http://127.0.0.1:8767/."
   - "Click Connect EV3. In the browser window, click the EV3, then click Connect."
   - "Keep that tab open."
   - "In Claude Code, type: list the robots."
5. Ask the person to read the state of the EV3 robot from the answer.
6. If the state is not `online`, use the row "EV3 not listed" of the fix table.
7. Tell the person to do the direction check:
   - "Put the robot on the floor with free space in front of it."
   - "In Claude Code, type: drive forward 5 cm."
   - "Look at the robot. Tell me if it moved forward or backward."
8. If the robot moved backward, open `<clone>/deployments/example/robots/r1.json`.
9. Under `profile.drivetrain`, change `"forward_sign": 1` to `"forward_sign": -1`. Save the file.
10. Tell the person to close Claude Code and start it again with the launch line.

Exit check: the EV3 is `online`, and "drive forward 5 cm" moves it forward.

### 9 REPORT

Give the person this report:

```text
Installed: git <v>, bun <v>, ant <v>, Claude Code <v>, browser <name or none>
Who pays: Console organization "<organization name>", profile spinecord
spinecord: <clone path>, registered with local scope in <mi-robot path>, robots <flags>
Doctor: doctor: ok
Smoke test: <answer>, cost USD <total_cost_usd>
EV3: online and forward | not checked
To do: <the steps the person must still do>
Start Claude Code with: <launch line>
```

## Fix table

| Problem | Cause | Fix |
|---|---|---|
| `Credit balance is too low` | The profile logged in to an organization with no credits | Run `ant auth login --profile spinecord2` and click the Console organization with the credits. Then use `spinecord2` in all commands |
| Wrong Console organization | The profile keeps its first organization | Same fix as `Credit balance is too low` |
| Another credential pays | A variable from state 4, or a claude.ai login, pays ahead of the profile | Tell the person the name of the variable. Unset it in this terminal (`unset NAME` or `Remove-Item Env:NAME`). Start Claude Code with the launch line |
| `Login method:` with the profile set | The profile name does not exist, or it has no login | Run `ant --profile spinecord auth status`. If there is no `Logged in to` line, do state 3 again |
| Windows profile folder | Claude Code does not find the profile that `ant` wrote | Set `$env:ANTHROPIC_CONFIG_DIR` to the `Config dir:` path from `ant auth status`. Run the state 4 check again |
| Port 8767 held | Another Claude Code session runs spinecord with `--ev3` | Close the other Claude Code session. Run the doctor again |
| EV3 not listed | The USB cable, the EV3 is off, or the browser is not Chrome or Edge | Connect the cable. Turn on the EV3. Open the page in Chrome or Edge, and click Connect EV3 again |
| PATH after an install | The terminal has the old `PATH` | Open a new terminal. On Windows, add the folder that the installer names to the user `PATH`, with approval |
| macOS firewall with `--lan` | The firewall blocks connections to bun | Run the fix of the doctor line `firewall`. It uses `sudo`: tell the person why |

## Rules

- Never ask the person to paste a key or a token into the chat.
- Never show a token, a key, an email, or the full output of `ant auth status`.
- Never run `ant auth print-credentials`.
- Never write a secret to a file. Never put `ANTHROPIC_PROFILE` in a settings file.
- Ask for approval of each install, clone and registration. Do the step only after a yes.
- Never use `sudo` until you tell the person why.
- Never change a shell profile or a user variable until the person agrees.
- Do the steps of a human step only after you tell the person what to click.
- If the same step fails 2 times, stop. Show the error and the row of the fix table.
- Register spinecord with local scope in `mi-robot`. Never register it with user scope.
- Do not start Claude Code in the clone for the robot. Use `mi-robot`.
