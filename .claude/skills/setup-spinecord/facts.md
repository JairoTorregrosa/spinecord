# Verified facts

The steps of this skill rest on these facts. Each fact has its source and the date of the check.
Read this file only when a step and the computer disagree. Then check the source again.

| Fact | Source | Checked |
|---|---|---|
| `ant` 2.14.0 is the current release, with zip files for macOS and Windows and `.tar.gz`, `.deb` and `.rpm` files for Linux. The archives hold the binary `ant` at their top | https://github.com/anthropics/anthropic-cli/releases | 2026-11-27 |
| macOS: `brew install anthropics/tap/ant` | https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart | 2026-11-24 |
| Linux: the release `.tar.gz` file, extracted to a folder on `PATH` | https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart, run in `ubuntu:24.04` | 2026-11-27 |
| Windows: `winget install Anthropic.Ant`, a portable zip package of the same release. winget has 2.14.0 | https://github.com/microsoft/winget-pkgs/tree/master/manifests/a/Anthropic/Ant | 2026-11-27 |
| `ant auth login` opens the browser. `--no-browser` prints the URL. `--profile <name>` makes that profile and makes it active. `--timeout` is 5 minutes by default | https://platform.claude.com/docs/en/cli-sdks-libraries/cli/authentication, `ant auth login --help` 2.14.0 | 2026-11-27 |
| With a browser, `ant auth login` sends the browser to platform.claude.com with a `redirect_uri` on `localhost:<port>`, listens on `127.0.0.1:<port>`, and waits for the answer even with no standard input | `ant` 2.14.0 in `ubuntu:24.04`, with a stub `xdg-open` | 2026-11-27 |
| On Linux, `ant auth login` opens the browser with `xdg-open`. Without it, `ant` prints the URL and asks for a pasted code | `ant` 2.14.0 in `ubuntu:24.04` | 2026-11-27 |
| A login that fails or times out writes no profile | `ant` 2.14.0 in `ubuntu:24.04` | 2026-11-27 |
| A profile keeps its organization for later logins. For another organization, log in with a new profile name | https://platform.claude.com/docs/en/cli-sdks-libraries/cli/authentication | 2026-11-24 |
| `ant auth status` exits 0 with no login, and the docs say not to script against its exit code. `ant --profile <p> models list` exits 1 with `401` when the profile has no login | `ant` 2.14.0 in `ubuntu:24.04`, the authentication page | 2026-11-27 |
| `ant auth status` prints `Logged in to <organization> as <email>`, the `Config dir:` path and the first characters of the token | `ant` 2.12.1 on macOS | 2026-11-24 |
| After a token refresh, `ant auth status` prints no organization name and no email. It still prints the line `Profile organization_id` | `ant` 2.14.0 on macOS, a profile before and after `ant models list` refreshed its token | 2026-11-27 |
| The profiles live in `ANTHROPIC_CONFIG_DIR`, else `~/.config/anthropic` (macOS, Linux), else `%APPDATA%\Anthropic` (Windows) | https://platform.claude.com/docs/en/manage-claude/wif-reference | 2026-11-24 |
| `ANTHROPIC_PROFILE` in the environment makes Claude Code use that profile, above a claude.ai login | https://code.claude.com/docs/en/authentication | 2026-11-24 |
| With no `ANTHROPIC_PROFILE`, a claude.ai login pays ahead of the active profile | https://code.claude.com/docs/en/authentication | 2026-11-24 |
| A profile name that does not exist makes Claude Code use the claude.ai login, with no error | Claude Code 2.1.331 on macOS | 2026-11-24 |
| `ANTHROPIC_PROFILE` in the `env` of `.claude/settings.json` or `.claude/settings.local.json` does not change who pays | Claude Code 2.1.331 on macOS, `/status` | 2026-11-24 |
| `claude auth status --text` prints `Profile: ... profile <name>` when a profile pays, and `Login method:` for a claude.ai login. It prints `Organization: <name> · <id>` only until the first token refresh of the profile. Then `setup` asks `ant` | Claude Code 2.1.332 on macOS, a profile before and after a refresh | 2026-11-27 |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and the cloud switches (`CLAUDE_CODE_USE_BEDROCK` and others) pay ahead of a profile | `examples/assistant/setup.ts` (`paysBeforeProfile`), https://code.claude.com/docs/en/authentication | 2026-11-24 |
| A host app can pass its own login to every command of its agent. In the Claude desktop app on Windows, `claude auth status` showed its Max login with `ANTHROPIC_PROFILE` set. A new terminal paid with the profile | A run of this skill in the Claude desktop app on Windows | 2026-11-27 |
| Claude Code 2.1.332 reads many login variables: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_SESSION_ACCESS_TOKEN`, `CLAUDE_CODE_HOST_CREDS_FILE`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` and others. So `setup` does not remove the names of a host. It runs `claude` and `ant` with the environment of a new terminal. For `ant` only, it removes `ANTHROPIC_PROFILE`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`, because `ant` takes `--profile` | `strings` of the `claude` 2.1.332 binary on macOS | 2026-11-27 |
| `setup` reads the environment of a new terminal from the login shell of the user database, started with only `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM` and a system `PATH` (macOS, Linux). The shell writes it to a file and runs in a process group of its own, which ends with the check. On Windows, `taskkill /T` ends the PowerShell tree only at the deadline. So a job that a profile starts cannot hold the check or outlive it. The variables that pay ahead of a profile are also read from the login session: `launchctl getenv` (macOS), and on Linux, read from disk, the `*.conf` files of the `environment.d` folders with the syntax of environment.d(5), then `/etc/environment` with the rules of pam_env (an `export ` prefix is dropped, a value ends at `#`). On Windows, from the Machine, volatile and User environment of the registry. The variables of the desktop session (`DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` and others) come from this session | `probeTerminal` in `scripts/setup.ts`, `setup status` on macOS 27.2 in an Agent SDK session with 13 host variables | 2026-11-27 |
| environment.d: `*.conf` files in `~/.config/environment.d`, `/etc`, `/run`, `/usr/local/lib` and `/usr/lib` (`environment.d` in each). `KEY=VALUE` lines. `#` and `;` start a comment line. Quotes are stripped. `${X}`, `${X:-default}` and `${X:+alternate}` expand. `$X` expands inside single quotes too. A user file masks a system file of the same name. `/etc/environment` is parsed too | https://www.freedesktop.org/software/systemd/man/latest/environment.d.html (systemd 262) | 2026-11-27 |
| `claude -p` ignores the `permissions.allow` of a folder that the person has not trusted. `--allowedTools mcp__spinecord` gives the tools | Claude Code 2.1.331 on macOS (PR #51) | 2026-11-24 |
| The first start of Claude Code 2.1.332 with `ANTHROPIC_PROFILE` set and no other login asks no login. It shows the color theme, then security notes with "Press Enter to continue", then the trust question. Its first option is "No, exit", or in `~/mi-robot` "No, continue without these permissions" | macOS 27.2, a new home folder, `tmux` | 2026-11-27 |
| `claude -p` takes `--max-budget-usd <amount>` and `--output-format json` | `claude --help` 2.1.332 | 2026-11-27 |
| Claude Code: `curl -fsSL https://claude.ai/install.sh \| bash` (macOS, Linux), `irm https://claude.ai/install.ps1 \| iex` (PowerShell). It installs to `~/.local/bin` and does not add that folder to `PATH` | https://code.claude.com/docs/en/setup, run in `ubuntu:24.04` | 2026-11-27 |
| bun: `curl -fsSL https://bun.com/install \| bash` (macOS, Linux, needs `unzip`), `powershell -c "irm bun.sh/install.ps1\|iex"` (Windows). The script installs to `~/.bun/bin` and adds it to `~/.bashrc` | https://bun.sh/docs/installation, run in `ubuntu:24.04` | 2026-11-27 |
| On macOS with no `~/.zshrc`, the bun installer adds no `PATH` line. A new terminal then finds no `bun`, and a registration with a bare `bun` fails to start (`ENOENT`) | bun 1.4.5 install script, macOS 27.2, `claude mcp get spinecord` in a new `zsh -il` | 2026-11-27 |
| spinecord needs bun 1.3.14 or later, and git | `package.json` `packageManager` of the clone, `docs/manual.md` | 2026-11-27 |
| git: `brew install git` or `xcode-select --install` (macOS), `winget install --id Git.Git -e --source winget` (Windows) | https://git-scm.com/install/mac, https://git-scm.com/install/windows | 2026-11-24 |
| The repository is public: the clone and the raw URL of this skill need no login | `gh repo view`, `curl -I` of the raw `README.md` | 2026-11-27 |
| `bun install --filter @spinecord/local` installs the server: 11 packages, 46 MB, under a second on a Mac with an empty cache. It leaves out the Claude Agent SDK, which only the experimental `--chat` needs | `bun bench/install.ts`, `docs/manual.md` | 2026-11-27 |
| `--view` serves the 3D view on `http://127.0.0.1:8769/`. A page that opens later still sees the calls. The page joins its server again after a restart, but it must load while a server runs | `bun apps/local/main.ts --help`, `apps/local/src/view.ts`, `apps/twin-view/src/main.ts` | 2026-11-27 |
| Local scope: only Claude Code sessions that start in `~/mi-robot` start a spinecord server. With `--ev3`, a second session cannot hold port 8767. With an EV3 on ev3dev, a second link can stop the motors during a move of the first | PR #51, `docs/manual.md` | 2026-11-24 |
| The launch line is `cd ~/mi-robot && ANTHROPIC_PROFILE=<profile> claude --model sonnet`, on Windows `cd $HOME\mi-robot; $env:ANTHROPIC_PROFILE = "<profile>"; claude --model sonnet`. Sonnet costs less than the largest model. The person can change the model in Claude Code with `/model` | `launchLine` in `scripts/setup.ts`, `claude --help` | 2026-11-27 |
| `setup workshop` copies the skills `robot-twin` and `setup-spinecord` to `~/mi-robot/.claude/skills/` and prints the line `skills`. The robot's Claude Code loads them from there | `PERSON_SKILLS` in `scripts/setup.ts` | 2026-11-27 |

Not verified:

- The folder where Claude Code reads `ant` profiles on native Windows. fixes.md has the row "No `Profile:` line on Windows".
- The winget flags `--accept-source-agreements` and `--accept-package-agreements`, and the `PATH` line for PowerShell, were not run on Windows.
- The Windows probe of the registry was not run on Windows.
- `ant auth login` on a Linux desktop with the variables of the desktop session was not run.
- A file of the login session that `setup` cannot read gives a `warn` line `session`. A key in that file is not seen.
- `setup` does not read `/etc/security/pam_env.conf` (`DEFAULT=`, `OVERRIDE=`), `/usr/etc/environment` or `~/.pam_environment` (`user_readenv=1`).
- The reading of the Linux login session was not run on real Linux.
- `taskkill /T` of the Windows probe at its deadline was not run on Windows.
- `open` on macOS, and on Windows the default browser of `ant auth login` and `rundll32.exe url.dll,FileProtocolHandler` of `setup view`.
