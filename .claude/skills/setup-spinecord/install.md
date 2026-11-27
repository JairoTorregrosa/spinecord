# Install: the states TOOLS and CLONE

Read only the section of this OS. Install only what the detect step did not find.
Install one tool at a time, and run `<tool> --version` after each install.
Keep a tool that prints a version. Do not upgrade it. Exception: a bun older than 1.3.14 gets `bun upgrade`.

## macOS (zsh)

In each command of this agent session, first make the new tools visible:

```sh
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
```

| Tool | Command |
|---|---|
| git, with Homebrew (`brew --version` prints a version) | `brew install git` |
| git, without Homebrew | `xcode-select --install`. PERSON: "A window opens. Click Install, then wait until it says done." On such a Mac, `git --version` itself opens the same window |
| bun | `curl -fsSL https://bun.com/install \| bash` |
| ant, with Homebrew | `brew install anthropics/tap/ant` |
| ant, without Homebrew | the zip below |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` |

ant without Homebrew (`uname -m` prints `arm64` on Apple silicon, `x86_64` on Intel):

```sh
V=2.14.0; A=$(uname -m | sed s/x86_64/amd64/); mkdir -p ~/.local/bin
curl -fsSL -o /tmp/ant.zip "https://github.com/anthropics/anthropic-cli/releases/download/v$V/ant_${V}_macos_$A.zip"
unzip -o -q /tmp/ant.zip ant -d ~/.local/bin && rm /tmp/ant.zip
```

Make the tools visible in every new terminal. This adds one line to `~/.zshrc`, once.
A new Mac has no `~/.zshrc`, and then the bun installer adds no line:

```sh
grep -qs 'HOME/.bun/bin:' ~/.zshrc || echo 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

## Linux (bash)

In each command of this agent session, first make the new tools visible:

```sh
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
```

| Tool | Command |
|---|---|
| git and unzip (bun needs unzip), Debian or Ubuntu | `sudo apt-get install -y git unzip`. Say first: "sudo installs system programs. It can ask for your computer password." |
| git and unzip, Fedora | `sudo dnf install -y git unzip`, with the same words |
| bun | `curl -fsSL https://bun.com/install \| bash` |
| ant | the lines below |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` |

ant, with no `sudo`:

```sh
V=2.14.0; A=$(uname -m | sed -e s/x86_64/amd64/ -e s/aarch64/arm64/); mkdir -p ~/.local/bin
curl -fsSL "https://github.com/anthropics/anthropic-cli/releases/download/v$V/ant_${V}_linux_$A.tar.gz" | tar -xz -C ~/.local/bin ant
```

Make the tools visible in every new terminal. This adds one line to `~/.bashrc`, once:

```sh
grep -qs 'HOME/.local/bin' ~/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

## Windows (PowerShell)

Use PowerShell for every command. A tool that an install adds is not visible to this agent session.
In each command after an install, first read `PATH` again:

```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
```

| Tool | Command |
|---|---|
| git | `winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements` |
| bun | `powershell -c "irm bun.sh/install.ps1\|iex"` |
| ant | `winget install --id Anthropic.Ant -e --accept-source-agreements --accept-package-agreements` |
| Claude Code | `irm https://claude.ai/install.ps1 \| iex` |

A winget install can open a Windows prompt "Do you want to allow this app to make changes?".
PERSON: "A Windows window asks for permission. Click Yes."
New terminals see the tools without more steps.

## Clone

Detect: the clone exists when `~/spinecord/scripts/setup.ts` exists.

New clone, in the home folder:

```sh
cd ~; git clone https://github.com/JairoTorregrosa/spinecord
```

Clone that exists already: update it. `--ff-only` refuses to change a clone with local changes. That is correct: stop, and show the error.

```sh
cd ~/spinecord; git pull --ff-only
```

Then, in both cases, install the server's packages. That takes a few seconds:

```sh
cd ~/spinecord; bun install --filter @spinecord/local
```

Exit check: `cd ~/spinecord; bun scripts/setup.ts status` prints lines, and its last line starts with `next`.
