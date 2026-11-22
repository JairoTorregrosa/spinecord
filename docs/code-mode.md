# spinecord from Claude Code with Code Mode

Code Mode lets Claude write one JavaScript script that makes many tool calls, passes results between them and returns only what it needs. For a robot that removes the model turn (2–10 s of thinking) between sensing and acting.

```
without   think → drive → think → read → think → turn → think → read …   one model turn per call
with      think → [ drive → read → turn → read → … ] → think             one model turn per loop
```

Source for everything about Code Mode here: <https://code.claude.com/docs/en/code-mode> (read 2026-11-21) and the sessions measured in §6. It is experimental and may change.

## 1. Enable

| Need | Value |
|---|---|
| Claude Code | ≥ 2.1.323, native build, interactive `claude` in a terminal |
| Account | Claude subscription or Console account (no gateway or cloud-provider access) |
| Model | Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable 5.2 |
| OS | macOS, Linux, WSL, Windows (Windows needs Git for Windows) |

macOS, Linux, WSL:

```bash
CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude
```

Windows PowerShell:

```powershell
$env:CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = "1"
claude
```

Confirm "Yes, turn on Code Mode" on first use. The session shows `Code Mode (experimental) is on`.

## 2. Add the server

The server is a process on this computer, with the robots inside (README, "Use it from Claude Code"):

```bash
claude mcp add spinecord -- bun <repo>/apps/local/main.ts
```

Check with `/mcp` inside Claude Code: `spinecord` is connected and lists its tools. Then ask for `list_robots`.

## 3. What a script gets from a call

### 3.1 The envelope

Every result is one envelope, `{ok, robot, data | error, next}`. `ok: true` → `data` is there. `ok: false` → `error: {code, message, retryable, retry_after_ms?}` is there and `data` is not. `robot` is `{id, backend, link, activity}` after the call; `list_robots` has none.

How the envelope reaches the script, in Claude Code 2.1.330 (observed 2026-11-22):

| Result | What `await tools["mcp__spinecord__<tool>"](args)` does |
|---|---|
| `ok: true` | resolves to a **string**: the envelope as JSON |
| `ok: false` (`isError`) | **rejects**. The error's `message` is the result's text block: a summary line, a newline, then the envelope as one line of JSON |

One helper turns both into the envelope, so the rest of a script reads fields and checks `ok`:

<!-- example: call -->

```javascript
const call = async (tool, args) => {
  let text;
  try {
    text = await tools["mcp__spinecord__" + tool](args);
  } catch (e) {
    // a result with ok:false is thrown; the last line of its message is the envelope
    try {
      return JSON.parse(String(e.message).split("\n").at(-1));
    } catch {
      throw e; // not a result: the call never reached the server
    }
  }
  return typeof text === "string" ? JSON.parse(text) : text;
};
```

A call that never reached the server is thrown too, with a message that does not end in JSON: Claude Code refuses a call that passes an argument the tool does not declare (`robot` where the tool takes `robot_id`) with "Not sent: …". The helper throws that error again, unchanged, and the script's `finally` stops the robot. Every tool but `list_robots` takes `robot_id`.

### 3.2 `data`, per tool family

`data` is an object in every tool, and a thing has one name wherever it appears (CONTRACT §7).

| Tools | `data` | Read it with |
|---|---|---|
| `list_robots` | `{robots: [{id, backend, link, activity, fault_reason, connect}]}` | `data.robots[0].id` |
| `describe_robot` | `{id, backend, devices: [{id, kind, roles, channels, commands, description}], roles, drivetrain, limits, notes}` | `data.roles.distance` → a device id; `data.limits.max_drive_cm` |
| `describe_device` | `{id, kind, roles, channels: [{name, type, unit?, range?, active?, …}], commands: [{name, params, bound, moves}]}` | `data.commands.find((c) => c.name === "tone").params` |
| `read_device` `read_all` `wait_until` | `{readings: [{device, channel, value, unit?, ts, error?}]}`, one reading per channel. `read_all` and `wait_until` add `ms`; `wait_until` adds `met` and `reason` | `data.readings.find((r) => r.channel === "distance_cm").value` |
| `sample_device` | `{samples: [[t_ms, value], …], min, max, mean, last, rate_hz, unit?}` | `data.mean`, `data.samples.at(-1)[1]` |
| `drive` `turn` `arc` | `{requested, applied, measured: {distance_cm, heading_change_deg, source, left_deg, right_deg}, clamped, reason, ms}` | `data.reason === "condition_met"`, `data.measured.distance_cm` |
| `command_device` | `{requested, applied, measured, clamped, reason, ms}`; `measured` is what the device reports | `data.reason === "completed"` |
| `stop` | `{motors_stopped, activity}` | `data.motors_stopped` |
| `reset_fault` | `{activity}` | `data.activity === "idle"` |
| `run_program` | `{outcome, reason, steps: [{path, tool, ok, reason \| error, ms}], steps_dropped, ms}` | `data.outcome === "succeeded"` |

A reading whose channel could not be read has `value: null` and an `error` string. `reason` of a move is `completed`, `condition_met`, `clamped`, `stalled`, `preempted` or `timeout`; anything but the first two means the request was not fully done. Every tool lists the same shape in its `outputSchema`.

### 3.3 What the server does so a script does not have to

| Fact | Why it matters in code |
|---|---|
| `until` on `drive` / `turn` / `arc` / `command_device` | The runtime watches the condition next to the hardware every max(10 ms, one read) while the motion runs and aborts it when met; no model turn and no script loop per check |
| A move's result carries `measured` | Distance and heading change need no read before and after the move |
| A condition and a read take a role (`distance`, `gyro`) or a device id (`ev3.S4`) | `describe_robot` gives both |
| `request_id` on moving tools | An optional label. Nothing is stored: the same call sent twice moves the robot twice |

## 4. Example: a square along the walls

Ask Claude:

> Use the spinecord MCP robot r1-sim. Four times: drive forward until the distance sensor reads 15 cm or less from the wall, then turn 90 degrees left. Then report, per leg, the distance driven, the sensor reading after stopping, and the turn angle.

The whole task is one script: twelve calls, three per leg. `call` is the helper of §3.1.

<!-- example: square -->

```javascript
async function square(call, robot_id) {
  // "distance" is a role of the example robot; describe_robot lists the roles and their devices
  const near = { device: "distance", channel: "distance_cm", op: "lte", value: 15 };
  const legs = [];
  let moved = false;
  let clean = false;
  try {
    for (let leg = 1; leg <= 4; leg++) {
      moved = true;
      // one bounded call: the runtime watches the sensor and brakes when the condition is met
      const d = await call("drive", { robot_id, distance_cm: 100, speed_pct: 30, until: near });
      if (!d.ok) return { failed: "drive", leg, error: d.error, legs };
      // completed (no wall within 100 cm), stalled, clamped, preempted, timeout: not what was asked
      if (d.data.reason !== "condition_met") return { ended: d.data.reason, leg, legs };

      // the one thing the moves do not report: the sensor after the stop
      const r = await call("read_device", { robot_id, device: "distance" });
      if (!r.ok) return { failed: "read_device", leg, error: r.error, legs };
      const wall_cm = r.data.readings.find((x) => x.channel === "distance_cm").value;

      const t = await call("turn", { robot_id, angle_deg: 90 }); // positive = left
      if (!t.ok) return { failed: "turn", leg, error: t.error, legs };
      if (t.data.reason !== "completed") return { ended: t.data.reason, leg, legs };

      legs.push({
        leg,
        driven_cm: d.data.measured.distance_cm,
        wall_cm,
        turned_deg: t.data.measured.heading_change_deg,
      });
    }
    clean = true;
    return { legs };
  } finally {
    // whatever left the loop early (an error envelope, an unexpected reason, a throw) ends with the wheels braked
    if (moved && !clean) await call("stop", { robot_id });
  }
}
```

In the session the script ends with `await square(call, "r1-sim")`: the last expression is what Claude gets back. `apps/local/test/code-mode.test.ts` cuts both blocks out of this page and runs them against the server over stdio, on the twin.

Rules the script follows (the server sends them in its instructions too):

| Rule | In the script |
|---|---|
| Check `ok` after every call | `if (!d.ok) return …` before touching `d.data` |
| Stop the loop on any error or unexpected `reason` | `return`, never `continue` |
| `stop` on failure | `try / finally` around everything that moves |
| Bounded | `leg <= 4`, `distance_cm: 100`, no `while (true)` |
| No blind retry of a move | A failed or unanswered `drive` is not sent again; read the robot first (`read_all`) |
| Read only what a move does not report | One `read_device` per leg; distance and angle come from `measured` |
| Return little | `legs`, not every reading |

## 5. When Code Mode helps

A script saves one model turn for every call that follows another without a decision of the model in between. It costs the turn that writes the script, and a script that is wrong costs that turn again.

| The task | Faster with |
|---|---|
| A fixed sequence of a few calls: drive, turn, read | plain tool calls. The model already knows every call when it starts; the calls themselves take as long in a script (§6) |
| A reaction to a sensor during one move | neither: `until` on the move. The runtime checks every 10 ms; a script loop checks once per call, a model once per turn |
| A decision between calls that code can make: branch on a reading, pick the next move from the last result | Code Mode. Each branch in a script is a turn the model does not take |
| A loop over sensor data: scan by turning and reading 12 times, keep the largest distance; repeat a leg until a reading changes | Code Mode. Twelve readings come back as one number |
| A behavior that runs unattended and reacts in milliseconds, with no value computed from readings | `run_program`: the loop runs next to the hardware and needs no script |
| Looking at a camera frame | plain tool calls. An image needs a model turn to be seen (§7) |

## 6. Measured

One run per row (n=1), 2026-11-22. Claude Code 2.1.330, interactive in tmux, model `claude-fable-5-2` at effort medium, the server started by the session as `bun apps/local/main.ts` (the twin `r1-sim` in `apps/local/examples/room.json`), a fresh empty directory, and the prompt of §4, word for word. The server column is the version the server reports (`serverInfo.version`). Read from the session transcript: wall time is first to last entry; a model request is one answer of the model; output tokens are summed once per model request; spinecord calls are the tool calls the transcript lists.

| Server | Code Mode | Wall time | Model requests | spinecord calls | Output tokens | Scripts that threw | Result |
|---|---|---|---|---|---|---|---|
| 2.0.0 | off | 58 s | 15 | 14 | 2,596 | — | 4 legs, stops at 15.0 / 15.1 / 15.3 / 15.6 cm, turns 89° |
| 2.0.0 | on | 134 s | 7 | 53 (40 `read_device`) | 3,565 | 1 | 4 legs, stops at 15.0 / 14.7 / 14.9 / 14.9 cm, turns 88–89° |
| 2.1.0 | on | 149 s | 5 | 77 (65 `read_device`) | 2,673 | 0 | 4 legs, stops at 14.5 / 14.7 / 14.8 / 14.8 cm, turns 89–90° |

What the rows show:

- For four legs with no decision between calls, plain calls are the faster way (§5). The twelve calls of §4 take about 18 s on the twin; the rest of a Code Mode run is the model writing scripts and the reads it adds to them.
- The script that threw in the 2.0.0 row read `data.readings` from `read_device`; server 2.0.0 answers `read_device` with a bare array. It stopped before any motion and cost one model request. Server 2.1.0 answers every channel read as `{readings}` (§3.2), and its instructions carry the shapes and the helper of §3.1.
- In every Code Mode run the model used `drive` with `until`, not a polling loop of its own, and added reads around each move to cross-check it (pose, odometer, gyro). Those reads are most of the calls and they vary from run to run: two more runs of the 2.1.0 setup on the same day, on a server that differed from 2.1.0 in at most three sentences of its instructions and descriptions, took 106 s with 29 calls and 107 s with 48 calls. With n=1 per row, a difference of tens of seconds or tens of calls between rows is within that spread. What held in all three: no script failed on the shape of a result.

## 7. Limits

| Limit | Value | What to do |
|---|---|---|
| Code you wait on | stops after 10 minutes | Keep one script to one task; a spinecord call is at most `max_command_ms`, a program at most `max_program_ms` |
| Permissions and hooks | every call in the code goes through them under the tool's usual name | Allow the spinecord tools once, or each call prompts mid-loop |
| A `PreToolUse` hook that does not finish | the call is refused | Keep hooks on these tools fast |
| Where it runs | terminal CLI only; no VS Code panel, Desktop app, cloud session, Remote Control | Run the robot session from a terminal |
| Resume | only in a terminal with Code Mode on | Keep the variable set |
| `wait_until` | ≤ 10 s per call | Loop it with a bound, or use `until` on the move |
| `sample_device` | ≤ 5 s, ≤ 50 Hz | Use it for trends instead of a read loop |
| Images | one image block per result, outside `structuredContent` | A camera frame still needs a model turn to be looked at |
| Stop | `Esc` stops the code; the docs do not say that a `finally` still runs | The robot finishes at most its current bounded command. Say "stop the robot" (the `stop` tool) if it must brake now |
