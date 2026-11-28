# Fixes

Find the row whose problem matches the failing line, and do its fix. Then run the check of the state again.
If the same step fails 2 times, stop. Show the person the error line and this row, in their language.

| Problem | Cause | Fix |
|---|---|---|
| `bun`, `ant` or `claude` not found right after its install | This session has the old `PATH` | Use the `PATH` line of install.md for this OS in the same command |
| A tool not found in a new terminal of the person | The shell profile has no `PATH` line | Do the "every new terminal" step of install.md. On Windows, run the installer again |
| `git pull --ff-only` refuses | The clone has local changes | Stop. Show the error. Do not discard the changes |
| The login did not finish | The person closed the page, or 5 minutes passed | Run `bun scripts/setup.ts login` again. The browser opens again |
| The login browser does not open | No browser on this computer, or the agent runs on another computer | The person runs `ant auth login --profile credits --no-browser` in a terminal of their own, opens the URL, and pastes the code there. Then run `bun scripts/setup.ts login` |
| The login page cannot reach the computer, and `127.0.0.1` refuses | The agent runs in a command sandbox with its own network | Run the login command outside the sandbox, or let the person run it as in the row above |
| `Credit balance is too low` | The profile logged in to an organization with no credits | Run `bun scripts/setup.ts login --profile credits2`. The person picks the organization with the credits |
| Wrong Console organization | A profile keeps its first organization | Same fix as `Credit balance is too low` |
| Another credential pays | A new terminal of the person sets a variable that pays ahead of the profile. The line `pays` of `setup status` names it | Say the name of the variable, never its value. The person removes it from the shell profile that sets it. On Windows: `[Environment]::SetEnvironmentVariable('NAME', $null, 'User')`. Then run the step again |
| Login method with the profile set | In the environment of a new terminal, the profile does not exist or has no login. So Claude Code takes its other login with no error | Run `bun scripts/setup.ts login`. Then run the step again. The line `host` is not the cause: the checks leave out the variables that it names |
| The environment of a new terminal could not be read | `setup` starts the login shell of the person, or on Windows reads the User environment with PowerShell. That failed or took more than 20 seconds. The line says why | Show the person the reason. A shell profile that waits for input or starts another program blocks it: the person fixes that line. Then run the step again. Never remove this check |
| No `Profile:` line on Windows | Claude Code does not find the profile that `ant` wrote | Run `ant --profile credits auth status`. Set `$env:ANTHROPIC_CONFIG_DIR` to its `Config dir:` path in the launch line and in this session. Run the step again |
| A doctor line `fail` | The line says why | The line `claude code`: run `bun scripts/setup.ts workshop`, which registers with local scope. Another line: run the command after `->`. If it names `bun apps/local/main.ts`, run it in `~/mi-robot` with the full path of the clone. Never use `-s user` |
| Port 8767 or 8769 held | Another Claude Code session runs spinecord | The person closes the other Claude Code (type `/exit`). Run the step again |
| `setup view` says nothing answers | The person's Claude Code did not start, or it waits at a question | Ask what the terminal shows. A trust question: choose Yes. Then run `bun scripts/setup.ts view` again |
| The person's Claude Code asks for a login method | The launch line did not set the profile, or it was typed in another folder | The person types `/exit`, then pastes the launch line again |
| The 3D page is blank or gray | The browser has no WebGL, or the page opened before the server | Reload the page. Else open it in Chrome or Edge |
| EV3 not `online` | The USB cable, the EV3 is off, or the browser is not Chrome or Edge | Connect the cable. Turn on the EV3. Open `http://127.0.0.1:8767/` in Chrome or Edge, and click Connect EV3 again |
| macOS firewall with `--lan` | The firewall blocks connections to bun | Run the fix of the doctor line `firewall`. It uses `sudo`: say why first |
