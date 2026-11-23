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
claude mcp add -s user spinecord -- bun "<repo>/apps/local/main.ts"
```

`bun apps/local/main.ts --print-add`, run in the clone, prints that line with the absolute path for the computer it runs on; on Windows use the printed line (it quotes the separator, `"--"`, for PowerShell). Start `claude` in a folder outside the clone.

Check with `/mcp` inside Claude Code: `spinecord` is connected and lists its tools. Then ask for `list_robots`.

## 3. What a script gets from a call

### 3.1 The envelope

Every result is one envelope, `{ok, robot, data | error, next}`. `ok: true` → `data` is there. `ok: false` → `error: {code, message, retryable, retry_after_ms?, measured?}` is there and `data` is not. `robot` is `{id, backend, link, activity}` after the call; `list_robots` has none.

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
| `describe_robot` | `{id, backend, devices: [{id, kind, roles, channels, commands, description}], roles, drivetrain, limits, notes, heading_error, scan_error}` | `data.roles.distance` → a device id; `data.drivetrain.max_drive_cm` (`data.drivetrain` is null on a robot without wheels) |
| `describe_device` | `{id, kind, roles, channels: [{name, type, unit?, range?, active?, null_when_absent?, …}], commands: [{name, params, bound, moves}]}` | `data.commands.find((c) => c.name === "tone").params` |
| `read_device` `read_all` `wait_until` | `{readings: [{device, channel, value, unit?, ts, error?, absent?}]}`, one reading per channel. `read_all` and `wait_until` add `ms`; `wait_until` adds `met` and `reason` | `data.readings.find((r) => r.channel === "distance_cm").value` |
| `sample_device` | `{samples: [[t_ms, value], …], min, max, mean, last, rate_hz, unit?}` | `data.mean`, `data.samples.at(-1)[1]` |
| `drive` `turn` `arc` | `{requested, applied, measured: {distance_cm, heading_change_deg, source, left_deg, right_deg}, clamped, clamps?, reason, note?, ms}`, plus `readings` when `reason` is `condition_met`: the readings that met `until` | `data.reason === "condition_met"`, `data.measured.distance_cm`, `data.readings[0].value` |
| `command_device` | `{requested, applied, measured, clamped, clamps?, reason, ms}`, plus `readings` like a move; `measured` is what the device reports | `data.reason === "completed"` |
| `stop` | `{motors_stopped, activity}` | `data.motors_stopped` |
| `reset_fault` | `{activity}` | `data.activity === "idle"` |
| `run_program` | `{outcome, reason, steps: [{path, tool, ok, reason \| error, measured?, clamped?, note?, ms}], steps_dropped, ms}` | `data.outcome === "succeeded"` |

A reading whose channel could not be read has `value: null` and an `error` string. A channel that `describe_device` marks `null_when_absent` (an infrared beacon's heading and distance) can read `value: null` with `absent: true`: nothing is in view, which is an answer and not a failure. Headings are positive to the left in every channel, `beacon_heading` included. `scan_error` of `describe_robot` is null while the device list is current; a string there says why the latest device scan failed, and `devices` is then the list of the last scan that succeeded. `reason` of a move is `completed`, `condition_met`, `clamped`, `stalled`, `preempted` or `timeout`; `completed` means the whole request was done, also when `clamped` is true: that flag beside `completed` says an argument that is not the target (the speed) was cut, and `clamps: [{arg, requested, applied, target}]` lists what. `clamped` as a reason means the target itself (distance, angle) was cut to a limit and the shorter target was reached. Test `reason`, never `clamped`, to know whether a move did what was asked. A nonzero target under the drivetrain's smallest move (0.05 cm and 0.47° on the example robot) is too small to make: the call sends nothing and answers `ok` with reason `completed`, `measured` of about 0 and `note`, a sentence that names the minimum. A computed correction such as `turn(90 - measured)` therefore passes `if (!t.ok) return` and the `completed` check when it comes out that small. A step of `run_program` carries the `reason` and `measured` of its call. Every tool lists the same shape in its `outputSchema`.

### 3.3 Errors a script meets

| `error.code` | What happened | In a script |
|---|---|---|
| `condition_unreadable` | A channel of the condition (`until`, `wait_until`, a program's `while`, `if`, `success`) returned no value in 3 polls in a row, or 10 polls in a row decided nothing. A move the condition guarded was braked there | Leave the loop. `error.measured` holds what the move had done, in the fields of `measured`. Read the robot (`read_all`) and check the sensor; the move is not to be sent again unread |
| `busy` | A moving call is in flight | A script that awaits each move never meets it; `error.retry_after_ms` says when to ask again |
| `robot_offline`, `timeout` on a move | The link closed or the backstop passed while the robot moved | Leave the loop; `next` starts with `read_all` |
| `fault`, `stop_unverified` | A stop could not be verified | Leave the loop; a person looks at the robot, then `reset_fault` |
| `unknown_device`, `unknown_channel`, `invalid_argument` | A name or an argument is wrong; the message lists the valid ones | Fix the script |

### 3.4 What the server does so a script does not have to

| Fact | Why it matters in code |
|---|---|
| `until` on `drive` / `turn` / `arc` / `command_device` | The runtime watches the condition next to the hardware every max(10 ms, one read) while the motion runs and aborts it when met; no model turn and no script loop per check |
| A move's result carries `measured` | Distance and heading change need no reads around the move |
| A move that `until` ended carries `readings` | The sensor value at the stop needs no read after it. A read made after the stop differs from it by the sensor's noise and can sit on the other side of the threshold |
| A condition and a read take a role (`distance`, `gyro`) or a device id (`ev3.S4`) | `describe_robot` gives both |
| `request_id` on moving tools | An optional label. Nothing is stored: the same call sent twice moves the robot twice |

## 4. Example: a square along the walls

Ask Claude:

> Use the spinecord MCP robot r1-sim. Four times: drive forward until the distance sensor reads 15 cm or less from the wall, then turn 90 degrees left. Then report, per leg, the distance driven, the sensor reading after stopping, and the turn angle.

The whole task is one script: eight calls, two per leg. `call` is the helper of §3.1.

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
      // an error ends the task. condition_unreadable (the sensor gave no value) braked the robot on the way:
      // error.measured is what this leg had driven
      if (!d.ok) return { failed: "drive", leg, error: d.error, driven_cm: d.error.measured?.distance_cm, legs };
      // completed (no wall within 100 cm), stalled, clamped, preempted, timeout: not what was asked
      if (d.data.reason !== "condition_met") return { ended: d.data.reason, leg, legs };

      // the reading that met the condition comes with the move: no read after the stop
      const wall_cm = d.data.readings.find((x) => x.channel === "distance_cm").value;

      const t = await call("turn", { robot_id, angle_deg: 90 }); // positive = left
      if (!t.ok) return { failed: "turn", leg, error: t.error, legs };
      // completed = the whole turn was made, also when clamped is true (only the speed was cut to the limit)
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
| Read only what a move does not report | No read at all: distance and angle come from `measured`, the sensor at the stop from `readings` |
| An unreadable sensor is an error, not "not met" | `condition_unreadable` leaves through `if (!d.ok)` with `error.measured` |
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

One run (n=1), 2026-11-22, Code Mode on. Server 3.0.0 (the version it reports in `serverInfo.version`), Claude Code 2.1.330, interactive in tmux, model `claude-fable-5-2` at effort medium, the server started by the session as `bun apps/local/main.ts` (the twin `r1-sim` in `apps/local/examples/room.json`), a fresh empty directory, and the prompt of §4, word for word. Read from the session transcript: wall time is first to last entry; a model request is one answer of the model; output tokens are summed once per model request; spinecord calls are the tool calls the transcript lists.

| Wall time | Model requests | spinecord calls | Output tokens | Scripts that threw | Result |
|---|---|---|---|---|---|
| 74 s | 3 | 27 (16 `read_device`) | 2,386 | 0 | 4 legs, stops at 14.9 / 14.7 / 14.6 / 14.9 cm, turns 88–90° |

What the run shows:

- Each leg is one `drive` with `until` and one `turn`: the reading that met the condition comes with the move (§3.4), and the model wrote no polling loop of its own.
- 16 of the 27 calls are reads the model added around the moves to cross-check them (pose, odometer, gyro). How many it adds is its choice in each run.
- The eight calls of §4 take about 18 s on the twin. The rest of the 74 s is the model writing scripts and those reads.
- No script threw: every channel read answers `{readings}` (§3.2), and the server's instructions carry the shapes and the helper of §3.1.
- With n=1, wall time and call count carry the spread of the model's choices.

## 7. Limits

| Limit | Value | What to do |
|---|---|---|
| Code you wait on | stops after 10 minutes | Keep one script to one task; a spinecord call is at most `max_command_ms`, a program at most `max_program_ms` |
| Permissions and hooks | every call in the code goes through them under the tool's usual name | Allow the spinecord tools once (`/permissions`, allow rule `mcp__spinecord`), or each call prompts mid-loop |
| A `PreToolUse` hook that does not finish | the call is refused | Keep hooks on these tools fast |
| Where it runs | terminal CLI only; no VS Code panel, Desktop app, cloud session, Remote Control | Run the robot session from a terminal |
| Resume | only in a terminal with Code Mode on | Keep the variable set |
| `wait_until` | ≤ 10 s per call | Loop it with a bound, or use `until` on the move |
| `sample_device` | ≤ 5 s, ≤ 50 Hz | Use it for trends instead of a read loop |
| Images | one image block per result, outside `structuredContent` | A camera frame still needs a model turn to be looked at |
| Stop | `Esc` stops the code. When Claude Code cancels the call in flight (`notifications/cancelled`), the server stops a move with the same verified stop as the `stop` tool and aborts any other call (CONTRACT §1, Cancellation). The docs do not say that a `finally` still runs | Do not count on `finally` to stop the robot. After `Esc`, read the robot (`read_all`) before the next move. "stop the robot" (the `stop` tool) brakes at any time |
