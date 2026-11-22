# spinecord from Claude Code with Code Mode

Code Mode lets Claude write one JavaScript script that makes many tool calls, passes results between them and returns only what it needs. For a robot that removes the model turn (2–10 s of thinking) between sensing and acting.

```
without   think → drive → think → read → think → turn → think → read …   one model turn per call
with      think → [ drive → read → turn → read → … ] → think             one model turn per loop
```

Source for everything about Code Mode here: <https://code.claude.com/docs/en/code-mode> (read 2026-11-21). It is experimental and may change.

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

```bash
claude mcp add --transport http spinecord https://<worker>.workers.dev/mcp --header "Authorization: Bearer <token>"
```

Check with `/mcp` inside Claude Code: `spinecord` is connected and lists its tools. Then ask for `list_robots`.

## 3. What the server gives a script

| Fact | Why it matters in code |
|---|---|
| Every result has `structuredContent` = `{ok, robot, data \| error, next}` | No parsing: read fields directly |
| Every tool has an `outputSchema` with its own `data` shape | The fields are known before the first call |
| The text block is `summary line` + `\n` + the same envelope as one-line JSON | Fallback when the client hands the script text: `JSON.parse(text.split("\n").at(-1))` |
| `isError` is true exactly when `ok` is false | An error is never disguised as data |
| `until` on `drive` / `turn` / `arc` / `command_device` | The runtime watches the condition next to the hardware every max(10 ms, one read) while the motion runs and aborts it when met; no model or relay round trip per check, unlike a polling loop in a script |
| `request_id` on moving tools | Same id + same arguments = the stored result, the robot does not act twice |

## 4. Example: drive until something is closer than 15 cm, then turn

Ask Claude:

> On robot t3-sim, drive forward until the distance sensor reads under 15 cm, then turn left 90°. Repeat up to 6 times. Do it in one script and tell me how far each leg went.

The script it should write looks like this. The Code Mode docs do not say how an MCP tool is exposed inside the code, so `call` is the one function to adapt: Claude binds it to the spinecord tools of its session.

```javascript
// call(tool, args) → the envelope {ok, robot, data | error, next}
// Adapt this line to how the session exposes MCP tools; the rest does not change.
const call = async (tool, args) => {
  const r = await mcp.spinecord[tool](args); // placeholder binding
  return r.structuredContent ?? JSON.parse(r.content[0].text.split("\n").at(-1));
};

const robot_id = "t3-sim";
const id = () => crypto.randomUUID(); // one request_id per intended action
const near = { device: "ev3.S4", channel: "distance_cm", op: "lt", value: 15 }; // ids come from describe_robot
const legs = [];
let moved = false;
let clean = false;

async function run() {
  try {
    for (let leg = 0; leg < 6; leg++) {
      moved = true;
      // one bounded call; the runtime stops the wheels when the condition becomes true
      const d = await call("drive", { robot_id, distance_cm: 80, speed_pct: 30, until: near, request_id: id() });
      if (!d.ok) return { failed: "drive", error: d.error, robot: d.robot, legs };
      legs.push({ leg, cm: d.data.measured.distance_cm, reason: d.data.reason });
      // stalled, clamped, preempted, timeout: not what was asked, so leave (the finally brakes)
      if (d.data.reason !== "condition_met" && d.data.reason !== "completed") return { ended: d.data.reason, legs };

      if (d.data.reason === "condition_met") {
        const t = await call("turn", { robot_id, angle_deg: 90, request_id: id() });
        if (!t.ok) return { failed: "turn", error: t.error, robot: t.robot, legs };
        if (t.data.reason !== "completed") return { ended: t.data.reason, legs };
      }
    }
    clean = true;
    return { legs };
  } finally {
    // anything that left the loop early (an error envelope, a throw) ends with the wheels braked
    if (moved && !clean) await call("stop", { robot_id });
  }
}
await run(); // the last expression is what Claude gets back
```

Rules the script follows (the server sends them in its instructions too):

| Rule | In the script |
|---|---|
| Check `ok` after every call | `if (!d.ok) return …` before touching `d.data` |
| Stop the loop on any error or unexpected `reason` | `return`, never `continue` |
| `stop` on failure | `try / finally` around everything that moves |
| Bounded | `leg < 6`, `distance_cm: 80`, no `while (true)` |
| No blind retry of a move | A failed or unanswered `drive` is not sent again with a new `request_id`; read the robot first (`read_all`) |
| Return little | `legs`, not every reading |

## 5. Limits

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
