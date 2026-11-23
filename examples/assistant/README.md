# Your personal robot assistant

A robot that helps one person with one thing: it reminds your grandmother of her pills, carries an order to a table, tells you the fern is thirsty, announces a visitor. You describe it in plain words in one file, [`assistant.md`](assistant.md). Claude reads that file and drives the robot through spinecord.

| File | What it is |
|---|---|
| [`assistant.md`](assistant.md) | **The only file you edit.** Who the assistant is, who it helps, its mission, its rules |
| [`missions/`](missions) | Three more assistants to copy from: a waiter, a plant alert, a guard |
| [`agent.ts`](agent.ts) | The program: it gives Claude your file and the robot's tools, and passes messages in and out. Read it top to bottom to see how an agent is made |
| [`setup.ts`](setup.ts) | The plumbing: the command line, reading `assistant.md`, the cost line |

It works with no robot: without flags the robot is a simulated twin in an empty room of 120 × 120 cm.

## 1. Install

You need [bun](https://bun.sh) ≥ 1.3.14 and git. macOS (Terminal) and Windows (PowerShell): the same commands.

```sh
git clone https://github.com/JairoTorregrosa/spinecord
cd spinecord
bun install --filter @spinecord/local --filter @spinecord/assistant-example
cd examples/assistant
```

The install is the spinecord server and the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), which brings its own copy of Claude Code: 378 MB on a Mac. You do not need Claude Code installed.

## 2. Who pays

The assistant thinks with Claude, and Claude is paid by use. Choose one of three ways and set it in the terminal where you run the assistant. At the start the program prints which one it uses, for example `paid by: Console login, ant profile work`. It never prints a key or a token.

| Way | Who pays | Good for |
|---|---|---|
| A. A Console login with the `ant` CLI | the credits of a Console organization | a class or a workshop: nobody makes or copies a key |
| B. A Console API key | the credits of the key's organization | your own computer |
| C. A Claude subscription token | your Claude plan (Pro, Max, ...), not credits | trying it yourself |

**A. A Console login with `ant`.** Install the [`ant` CLI](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/authentication), then:

```sh
ant auth login     # the browser opens: sign in to platform.claude.com and pick the organization with the credits
ant auth status    # shows the organization and the active profile, for example "Active profile: work"
```

Then name that profile for the assistant. macOS:

```sh
export ANTHROPIC_PROFILE=work
```

Windows PowerShell:

```powershell
$env:ANTHROPIC_PROFILE = "work"
```

The profiles live in `~/.config/anthropic/` (Windows: `%APPDATA%\Anthropic`), or in the folder `ANTHROPIC_CONFIG_DIR` names. Claude Code skips a profile it cannot use without a word, and this computer's Claude Code login pays in its place. So the program does not start when the profile in `ANTHROPIC_PROFILE` is not in that folder or is not logged in; it names the profile and the folder.

**B. A Console API key.** Make a key in the [Claude Console](https://platform.claude.com/) (API keys → Create key). macOS:

```sh
export ANTHROPIC_API_KEY=your-key
```

Windows PowerShell:

```powershell
$env:ANTHROPIC_API_KEY = "your-key"
```

A key is a password to your credits: do not paste it in a file of this folder, in a chat or on a screen others see.

**C. A Claude subscription token.** With Claude Code installed, `claude setup-token` makes a token that lasts a year. Put it in `CLAUDE_CODE_OAUTH_TOKEN` the same way. It counts against your plan, not credits, and it is for you alone: Anthropic does not allow a product for other people to be built on a claude.ai login, so an assistant you hand to someone else uses A or B.

Each variable lasts until you close that terminal. When none is set, a computer where Claude Code is logged in pays with that login: `paid by: this computer's Claude Code login`.

<details>
<summary>Which one wins, and the cloud providers</summary>

Claude Code takes the first of these that is set ([authentication](https://code.claude.com/docs/en/authentication)): a cloud provider, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, the profile in `ANTHROPIC_PROFILE`, this computer's Claude Code login. The program does not start when `ANTHROPIC_PROFILE` is set together with one that comes before it, because the profile would not pay. After the start it asks Claude Code which login it uses and stops when that is not the one the environment chose.

The cloud providers, from the same environment ([quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)):

- Amazon Bedrock: `CLAUDE_CODE_USE_BEDROCK=1` and AWS credentials.
- Claude Platform on AWS: `CLAUDE_CODE_USE_ANTHROPIC_AWS=1`, `ANTHROPIC_AWS_WORKSPACE_ID` and AWS credentials.
- Google Cloud's Agent Platform: `CLAUDE_CODE_USE_VERTEX=1` and Google Cloud credentials.
- Microsoft Foundry: `CLAUDE_CODE_USE_FOUNDRY=1` and Azure credentials.

The SDK does not read `.env` files.

</details>

## 3. Talk to it

```sh
bun agent.ts
```

The run below was `bun agent.ts --max-usd 0.40`:

```text
Pilar is waking up (model claude-opus-5-5, budget $0.40). Ctrl+C stops the robot and ends.
Write to Pilar and press Enter. Write bye to end.
you> who are you and what robot do you have?
  -> list_robots
  -> describe_robot (robot_id r1-sim)
Pilar> I'm Pilar, the robot assistant that reminds your grandmother Rosa to take her pills: the blue one at 08:00 and the white one at 20:00. My robot is r1-sim, which is a simulated EV3 robot in a 120 x 120 cm room, not a physical one. [...]
[turn 1: $0.0517, 33645 tokens read (28637 from cache), 289 written | total $0.0517 of $0.40]
you> do your mission now
  -> read_device (robot_id r1-sim)
  -> drive (robot_id r1-sim)
  -> read_device (robot_id r1-sim)
  -> run_program (robot_id r1-sim)
Pilar> I ran a practice reminder: Rosa's chair was 52 cm ahead, I drove 37 cm slowly and stopped 15.7 cm from it. I beeped three times and said: "Hello Rosa, this is a practice. [...]"
[turn 2: $0.0459, 67627 tokens read (65569 from cache), 820 written | total $0.0976 of $0.40]
```

- A line that starts with `->` is the assistant using the robot: the tool and the robot.
- A line in `[ ]` is what the turn cost, and the total of the session against its budget.
- A line that starts with `/` is not passed on: Claude Code's commands (`/clear`, `/model`, ...) are not for this assistant.
- A line with a word that starts with `@` is not passed on: Claude Code would read that file of your computer into the message (`@notes.txt`). An `@` inside a word, as in `a@b.com`, passes.

## 4. Let it act on its own

```sh
bun agent.ts --every 60
```

Every 60 seconds the program wakes the assistant up and tells it the time. The assistant reads the section "When I act on my own" of your file and decides: it acts, or it answers `nothing to do`. It is one conversation from start to end, so the assistant remembers what it already did (the pill was given, the alert was sent).

The run below was `bun agent.ts --every 15 --for 1 --max-usd 0.40`:

```text
Pilar wakes up every 15 s for 1 min.
tick Sunday 2026-11-22 18:52
  -> list_robots
  -> describe_robot (robot_id r1-sim)
  -> read_device (robot_id r1-sim)
  -> describe_device (robot_id r1-sim)
  -> drive (robot_id r1-sim)
  -> read_device (robot_id r1-sim)
Pilar> I'm about 15 cm from Rosa now, so I'll beep three times and speak.
  -> run_program (robot_id r1-sim)
  -> run_program (robot_id r1-sim)
Pilar> This was my first wake-up, so I gave the practice reminder, even though 18:52 is not a pill time. [...]
[turn 1: $0.1065, 105384 tokens read (98265 from cache), 1486 written | total $0.1065 of $0.40]
tick Sunday 2026-11-22 18:53
Pilar> nothing to do
[turn 2: $0.0048, 15695 tokens read (15493 from cache), 7 written | total $0.1114 of $0.40]
```

| Option | Does |
|---|---|
| `--every [seconds]` | wake up every N seconds: 60 without a number, 10 at least. A turn that takes longer than N is followed at once by the next one |
| `--for <minutes>` | with `--every`: end after this many minutes |
| `--max-usd <amount>` | end at the first turn that brings the session to this amount. Default 1. The last turn can pass it by about the cost of one step |
| `--mission <file>` | another assistant file, for example `--mission missions/guard.md` |
| `--help` | every option |

## 5. Make it yours

Open `assistant.md` in any text editor. Keep the six titles (the lines that start with `##`) and change the words under them. Write in any language: the assistant answers in the language of the file.

| Title | Write there |
|---|---|
| `## Name` | what the assistant is called |
| `## Who I help` | the person, and how to speak to them |
| `## My robot` | only what is special about yours (a plate on top, a button with a meaning). The assistant asks the robot itself for its motors and sensors |
| `## My mission` | what it does, step by step, with distances and times |
| `## When I act on my own` | what makes it act when it wakes up, and how often |
| `## Rules` | what it never does: stay on the floor, stop when unsure, how far it may move at a time |

Save the file and start the program again. A title that is missing or empty stops the start and names the title. To begin from another example: copy a file of `missions/` over `assistant.md`, or run it as it is with `--mission`.

The model is the line `export const MODEL = "claude-opus-5-5";` at the top of `agent.ts`.

## 6. Stop the robot

| What you do | What happens |
|---|---|
| Press `Ctrl+C` | The program interrupts Claude, the move that is running is cancelled and the robot brakes. Then the spinecord server stops every motor and exits. Checked on the twin |
| Write `stop the robot` in the chat | The assistant calls the `stop` tool |
| Write `bye` in the chat | The program ends the same way as with `Ctrl+C` |
| The budget or `--for` is reached | The same end |

`Ctrl+C` is the way to stop when you are in a hurry: the program waits for Claude about 10 s at most, and the robot stops at once, because the spinecord server stops every motor on `SIGINT` and when its input closes. On a real robot keep a hand near it on a first run; what spinecord does when the cable or the network goes away is in [Stopping the robot](../../README.md#stopping-the-robot).

## 7. A real robot

Everything after a lone `--` goes to the spinecord server and chooses the robot:

```sh
bun agent.ts -- --ev3
bun agent.ts --every 60 -- --ev3dev --ssh robot@HOST
```

Write the brick's address in place of `HOST`. The flags are the server's own: [Choose the robots](../../README.md#choose-the-robots), or `bun ../../apps/local/main.ts --help`. To keep the server's log, add `--log-file robot.log` after the `--`. Try a mission on the twin first.

## What it costs

Measured on 2026-11-22 with `claude-opus-5-5`, the pill assistant and the twin. The numbers are the SDK's estimate, not a bill.

| Turn | Cost |
|---|---|
| A chat answer that reads the robot (2 tool calls) | $0.05 |
| A chat turn that does the mission (4 tool calls) | $0.05 |
| A wake-up that does the mission from the start (8 tool calls) | $0.11 |
| A wake-up that answers `nothing to do` | $0.004 to $0.005 |

`--every 60` with nothing to do is about $0.30 an hour, an estimate from the wake-ups above (60 an hour at $0.005). Claude keeps what it has already read in a cache at a lower price. These runs used a Claude Code login, whose cache lasts an hour; with an API key it lasts 5 minutes, so `--every` above 300 reads everything at full price at every wake-up and costs more (not measured here). The program ends at the first turn that reaches `--max-usd`, and that turn can pass it by about one step.

## What the agent may do

`agent.ts` gives Claude one MCP server, spinecord, and nothing else: none of Claude Code's tools for files, the shell or the web exist for this agent, no chat line with a word that starts with `@` reaches Claude (Claude Code reads an `@file` mention into the message without any tool, so the chat refuses it), the settings and memory of your computer are not loaded, and a tool call that would need a question to a person is denied. Each turn is bounded to 15 steps. The tests in [`test/`](test) check that options object and never call Claude: `bun test`.
