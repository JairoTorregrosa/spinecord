// The agent-facing MCP surface. Single source for tool names, descriptions, input schemas and output schemas.
// apps/local serves these verbatim (tools/list) and validates inputs against `input` before anything else.
// Every result is the envelope of CONTRACT §7; `output` is its JSON Schema with the tool's own `data` shape,
// so a client that writes code against the tools knows the fields without a trial call.
// Writing rules: first sentence = what it does and what it returns. Then: when to use, preconditions,
// postconditions, units, failure codes. No use-case names. A description promises only what the process does.
// Everything a caller needs is here or in describe_robot / describe_device output.

import { ACTIVITY_TRANSITIONS, type BackendKind, type ErrorCode, LINK_TRANSITIONS, type StopReason } from "./types";

export const SERVER_NAME = "spinecord";
export const SERVER_VERSION = "3.0.0";

export const SERVER_INSTRUCTIONS = `Controls the robots this process runs on this computer: physical robots (for example LEGO EV3 bricks) and simulated twins. The tool set is fixed and generic: a robot is a set of devices; each device describes its readable channels and its bounded commands.

How to work:
1. list_robots, then describe_robot to learn devices, roles, drivetrain, limits and notes. Every tool but list_robots takes robot_id, the id list_robots gives. describe_device gives one device's full channel and command schemas. A robot whose link is offline says in \`connect\` what a person must do to bring it online.
2. Prefer the drivetrain tools (drive, turn, arc) for motion. Use command_device for any other actuator. Every command is bounded (degrees, milliseconds or instant) and clamped to the robot's limits; nothing runs open-ended.
3. Close the loop: after acting, read_device / read_all / sample_device, or look through a camera device (read_device on an image channel). Compare requested vs measured in every result; physical robots slip.
4. To react to the world inside one action, pass an \`until\` condition; to wait without moving, use wait_until. run_program runs a whole behavior, given inline as data, next to the hardware.
5. Test on a twin first when there is one: a robot with backend sim has the same devices as the hardware robot plus a "sim.world" device.
6. One moving call at a time per robot: a second one fails with busy, it is not queued. Call stop the moment something looks wrong. stop never waits behind another call.

Every result is JSON: {ok, robot:{id, backend, link, activity}, data | error:{code, message, retryable, retry_after_ms?, measured?}, next:[suggested tools]}. ok true → data is present; ok false → error is present and data is absent. Errors are never disguised as data; a missing value is null with an error string. Nothing is stored between calls: a moving call sent twice moves twice, so after a failed or unanswered moving call read the robot (read_all) before moving again. Units: cm, degrees (positive = counter-clockwise = left, in every channel and command, an infrared sensor's beacon_heading included), speed in percent of max, time in ms.

A condition (\`until\`, wait_until, a program's while, if or success) never takes a channel it cannot read as "not met": after 3 polls in a row without a value, or 10 polls in a row that decided nothing, the call fails with condition_unreadable. A move the condition guarded was braked there and error.measured holds what it had done; read the robot (read_all) and check the sensor, and do not send the move again unread. A channel that describe_device marks null_when_absent may read null with absent:true (nothing in view, e.g. no beacon): that is an answer, and a comparison on it is not met.

Result format: structuredContent is the envelope and matches the tool's outputSchema. The text block repeats it for clients without structured output: line 1 is a one-line summary, the last line is the envelope as single-line JSON.

Shapes of \`data\` (always an object, never a bare array):
- list_robots: {robots:[{id, backend, link, activity, fault_reason, connect}]}.
- read_device, read_all, wait_until: {readings:[{device, channel, value, unit?, ts, error?, absent?}]}, one reading per channel: readings.find(r => r.channel === "distance_cm").value. read_all and wait_until add ms; wait_until adds met and reason.
- drive, turn, arc, command_device: {requested, applied, measured, clamped, reason, ms}, plus readings (the same shape) when reason is condition_met: the readings that met \`until\`. measured of drive, turn and arc has the same fields: distance_cm, heading_change_deg, source, left_deg, right_deg.
- sample_device: {samples:[[t_ms, value]], min, max, mean, last, rate_hz}. stop: {motors_stopped, activity}. run_program: {outcome, reason, steps, ms}.

If you write code that calls these tools (several calls in one script):
- What a call hands the script depends on the client that runs it: the envelope as an object, or the envelope as JSON text, and a result with ok:false may be thrown (the thrown message is the text block, so its last line is the envelope JSON). Define one helper that returns the envelope in every case and make every call through it: const call = async (tool, args) => { let r; try { r = await TOOL(tool, args); } catch (e) { try { return JSON.parse(String(e.message).split("\\n").at(-1)); } catch { throw e; } } return typeof r === "string" ? JSON.parse(r) : (r.structuredContent ?? r); }; where TOOL is how the client exposes these tools. An error the helper throws again never reached the server (an argument the tool does not declare): read its message.
- Compose the whole sense → act loop in one script and return only what you need; do not spend a model turn per call. A move's result carries what it measured (data.measured) and, when \`until\` ended it, the readings that met the condition (data.readings): read only what the move does not report.
- Check \`ok\` after every call. On ok:false leave the loop at once and return the error; never continue on stale data.
- Await each moving call before the next one on the same robot; reads may run in parallel with a move.
- A script that moves the robot wraps the motion in try/finally and calls stop in the finally whenever it did not finish cleanly.
- Bound every loop (iterations and total time) and keep the script well under 10 minutes; prefer one call with \`until\` over a fast polling loop.`;

const robotId = { type: "string", description: "Robot id from list_robots." } as const;
const requestId = {
  type: "string",
  maxLength: 64,
  description:
    "Optional label for this call. It is not an idempotency key: nothing is stored, and the same call sent twice acts twice.",
} as const;
const speed = {
  type: "number",
  minimum: 1,
  maximum: 100,
  description: "Speed in percent of maximum. Default 30. Clamped to the robot's max_speed_pct.",
} as const;
const condition = {
  type: "object",
  description:
    'Condition over device channels. Leaf: {device, channel, op, value}; op ∈ lt,lte,gt,gte (numbers), eq,neq, changed (no value), contains (vector channel includes value, e.g. buttons.pressed contains "enter"). Combine with {any:[...]}, {all:[...]}, {not:{...}}. Device may be an id or a role.',
} as const;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  /** JSON Schema 2020-12 of the result envelope {ok, robot?, data | error, next} with this tool's `data`. Served as outputSchema. */
  output: OutputSchema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
// nothing is stored between calls: a tool that moves the robot moves it again on every call
const act = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const meta = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const CATALOG: Omit<ToolDef, "output">[] = [
  // ---------- Discovery ----------
  {
    name: "list_robots",
    title: "List robots",
    annotations: ro,
    description:
      "Lists the robots this process runs, with their state. Returns {robots:[{id, backend (ev3 = a physical EV3 brick, on stock firmware or on ev3dev | sim = a simulated twin | null while the robot is offline), link (offline|handshaking|online), activity (idle|acting|stopping|running_program|fault), fault_reason (why it is in fault, else null), connect (what a person must do to bring an offline robot online, else null)}]}. Start here.",
    input: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "describe_robot",
    title: "Describe robot",
    annotations: ro,
    description:
      "Returns everything needed to use one robot: {id, backend, devices:[{id, kind, roles, channels (names), commands (names), description}], roles (role → device id), drivetrain (wheel geometry, or null if the robot cannot drive), limits:{max_speed_pct, max_command_ms, max_drive_cm, max_turn_deg, max_program_ms}, notes (facts about how it is built), scan_error (null when the device list is current; else why the latest device scan failed, and devices is then the list of the last scan that succeeded)}. Call before acting and again after an error mentioning unknown_device, since attached devices can come and go.",
    input: { type: "object", properties: { robot_id: robotId }, required: ["robot_id"], additionalProperties: false },
  },
  {
    name: "describe_device",
    title: "Describe device",
    annotations: ro,
    description:
      "Returns one device's full spec: every channel (name, type number|boolean|string|vector|image, unit, range, max_rate_hz, accuracy note, active, null_when_absent) and every command (name, description, JSON Schema of params, bound kind degrees|ms|instant and its max, whether it moves). Use it before command_device on a device you have not used, and to discover what an attached device can do.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        device: { type: "string", description: 'Device id (e.g. "ev3.S3") or role (e.g. "floor_color").' },
      },
      required: ["robot_id", "device"],
      additionalProperties: false,
    },
  },

  // ---------- Sensing ----------
  {
    name: "read_device",
    title: "Read device",
    annotations: ro,
    description:
      "Reads current values of one device's channels. Returns {readings:[{device, channel, value, unit?, ts, error?}]}, one reading per channel, the shape read_all returns. Reading never changes the device: without `channels` it reads the device's active non-image channels and leaves out the ones that need a sensor mode switch (active:false in describe_device). Name such a channel in `channels` to switch the mode and read it (only while the robot is idle, else busy; side effects are described per channel, e.g. switching the EV3 gyro resets its angle). A channel that could not be read has value null and an error string; a channel marked null_when_absent in describe_device can read value null with absent: true, which is an answer (nothing in view), not a failure. Naming an image channel (e.g. a camera's \"frame\", one per call) returns the picture as an image content block, and its reading is {device, channel, value: null, image: true, mime, age_ms, ts}; a frame older than 1500 ms fails with stale_image. Works in any activity state while the robot is online.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        device: { type: "string", description: "Device id or role." },
        channels: {
          type: "array",
          items: { type: "string" },
          description:
            "Channel names from describe_device. Omit to read every active non-image channel; an image channel or one with active:false is read only when named here.",
        },
      },
      required: ["robot_id", "device"],
      additionalProperties: false,
    },
  },
  {
    name: "read_all",
    title: "Read all sensors",
    annotations: ro,
    description:
      "Reads every active non-image channel of every device in one call, without changing any device (no mode switches). Returns {readings:[{device, channel, value, unit, ts, error?}], ms}. Cheapest way to see the whole robot's state after an action.",
    input: { type: "object", properties: { robot_id: robotId }, required: ["robot_id"], additionalProperties: false },
  },
  {
    name: "sample_device",
    title: "Sample channel over time",
    annotations: ro,
    description:
      "Samples one numeric channel repeatedly and returns {samples:[[t_ms, value]...], min, max, mean, last, rate_hz (the rate used), unit?}. rate_hz defaults to 10 and is capped by the channel's max_rate_hz and 50; duration_ms ≤ 5000. Use it to see trends (is the distance shrinking? is the color stable?) rather than calling read_device in a loop.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        device: { type: "string", description: "Device id or role." },
        channel: { type: "string", description: "One active channel of type number." },
        rate_hz: {
          type: "number",
          minimum: 1,
          maximum: 50,
          description: "Samples per second. Default 10. Capped by the channel's max_rate_hz.",
        },
        duration_ms: { type: "integer", minimum: 100, maximum: 5000, description: "How long to sample, ms." },
      },
      required: ["robot_id", "device", "channel", "duration_ms"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_until",
    title: "Wait for condition",
    annotations: ro,
    description:
      "Waits without moving until a condition over device channels becomes true or timeout_ms passes (≤ 10000). Returns {met: boolean, reason (condition_met | timeout | preempted), ms (how long it waited), readings (the values that decided it, the shape read_all returns)}. Not an error when the timeout passes: check met. A condition channel that returns no value in 3 polls in a row fails with condition_unreadable. The condition is read poll_hz times per second (default 20). Use for waiting on a button, a person, a light change.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        condition,
        timeout_ms: { type: "integer", minimum: 50, maximum: 10000, description: "Longest wait, ms." },
        poll_hz: {
          type: "number",
          minimum: 1,
          maximum: 50,
          description: "How often the condition is read, per second. Default 20.",
        },
      },
      required: ["robot_id", "condition", "timeout_ms"],
      additionalProperties: false,
    },
  },

  // ---------- Acting ----------
  {
    name: "drive",
    title: "Drive straight",
    annotations: act,
    description:
      "Drives straight by distance_cm (negative = backwards) using the robot's drivetrain, then brakes. Returns {requested:{distance_cm, speed_pct}, applied (the request after clamping), measured:{distance_cm, heading_change_deg, source, left_deg, right_deg}, clamped, reason, ms}; reason ∈ completed | condition_met | clamped | stalled | preempted | timeout. With `until`, stops early when the condition becomes true (reason condition_met) and distance_cm is then the maximum. data.readings then holds the readings that met the condition: use them, since a read made after the stop can sit on the other side of the threshold by the noise of the sensor (approx in describe_device). A condition channel that returns no value fails the call with condition_unreadable: the move was braked and error.measured holds what it had done. Measured values come from wheel encoders, not the request. Requires: online, idle (one moving call at a time, else busy), a drivetrain (else unsupported). Clamped to max_drive_cm.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        distance_cm: { type: "number" },
        speed_pct: speed,
        until: condition,
        request_id: requestId,
      },
      required: ["robot_id", "distance_cm"],
      additionalProperties: false,
    },
  },
  {
    name: "turn",
    title: "Turn in place",
    annotations: act,
    description:
      "Rotates in place by angle_deg (positive = counter-clockwise/left, negative = right), then brakes. Returns the shape drive returns: {requested:{angle_deg, speed_pct}, applied, measured:{distance_cm, heading_change_deg (the angle turned), source (gyro if present, else encoders), left_deg, right_deg}, clamped, reason, ms}. Supports `until` like drive. Requires a drivetrain. Clamped to max_turn_deg.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        angle_deg: { type: "number" },
        speed_pct: speed,
        until: condition,
        request_id: requestId,
      },
      required: ["robot_id", "angle_deg"],
      additionalProperties: false,
    },
  },
  {
    name: "arc",
    title: "Drive along an arc",
    annotations: act,
    description:
      "Drives along a circular arc, then brakes. radius_cm (> 0) is measured to the robot's center. angle_deg is the heading change: positive = curve left (counter-clockwise), negative = curve right. direction forward (default) or backward. Example: a quarter circle to the right while moving forward = {radius_cm: 20, angle_deg: -90}. Returns the same shape as drive with measured distance and heading change. Supports `until`. Requires a drivetrain.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        radius_cm: { type: "number", exclusiveMinimum: 0 },
        angle_deg: { type: "number" },
        direction: { type: "string", enum: ["forward", "backward"], description: "Default forward." },
        speed_pct: speed,
        until: condition,
        request_id: requestId,
      },
      required: ["robot_id", "radius_cm", "angle_deg"],
      additionalProperties: false,
    },
  },
  {
    name: "command_device",
    title: "Command a device",
    annotations: act,
    description:
      "Runs one named command on one device, e.g. a motor's run_degrees, a speaker's tone, a display's text, a servo's set_angle, the twin's sim.world load_world. Args must match the command's params schema from describe_device. Every command is bounded (bound.kind degrees|ms|instant) and clamped; returns {requested, applied (the request after clamping), measured (what the device reports), clamped, reason, ms}. Supports `until` for commands that move. Commands that move require idle (one moving call at a time, else busy); commands that do not move (sound, display, light) run in every state but fault.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        device: { type: "string", description: "Device id or role." },
        command: { type: "string" },
        args: { type: "object", description: "Per the command's params schema." },
        until: condition,
        request_id: requestId,
      },
      required: ["robot_id", "device", "command"],
      additionalProperties: false,
    },
  },
  {
    name: "stop",
    title: "Stop robot",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      "Immediately brakes every actuator and aborts any running command or program, without waiting behind it. Returns {motors_stopped: boolean, activity}. If the stop cannot be verified (every motor must read speed 0) the robot enters fault. Allowed in any state. Use whenever something looks wrong.",
    input: { type: "object", properties: { robot_id: robotId }, required: ["robot_id"], additionalProperties: false },
  },
  {
    name: "reset_fault",
    title: "Clear fault",
    annotations: meta,
    description:
      'Leaves the fault state after verifying all motors are stopped. Returns {activity: "idle"} or fails with stop_unverified. Only valid in fault (else illegal_state). A fault means a stop could not be confirmed: read the robot (read_all) and check its cable and power first.',
    input: {
      type: "object",
      properties: { robot_id: robotId, request_id: requestId },
      required: ["robot_id"],
      additionalProperties: false,
    },
  },

  // ---------- Programs ----------
  {
    name: "run_program",
    title: "Run program",
    annotations: act,
    description:
      "Runs a behavior given inline as data (no code) next to the hardware and waits for it. body is a tree of nodes: {seq:[...]}, {repeat:{times≤50, body}}, {while:{cond, body, max_iterations≤200}}, {if:{cond, then, else?}}, {call:{tool: drive|turn|arc|command_device|wait_until, args}}, {wait_ms≤10000}, {succeed:msg}, {fail:msg}. Args inside calls omit robot_id and request_id. The optional success condition is checked at the end. Returns {outcome: succeeded|failed|aborted|timeout, steps:[{path, tool, ok, reason|error, ms}], ms}. Requires idle (else busy). Activity is running_program until it ends; stop aborts it. Total time is capped by max_program_ms. Nothing is stored: send the body with every call.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        body: { type: "object", description: "Program tree." },
        success: condition,
        request_id: requestId,
      },
      required: ["robot_id", "body"],
      additionalProperties: false,
    },
  },
];

// ---------- Output schemas ----------
// Built from the types in types.ts: enums come from the transition tables or from lists that tsc checks against
// the unions. Clients reject a result that does not match its schema, so a schema promises only what the server
// guarantees: objects stay open (no additionalProperties:false); `required` and `enum` appear only on what
// apps/local builds itself (envelope, robot state, error, the robot list). Data the runtime or a device produces
// is passed through unverified, so there the fields are typed and the expected values are named in the
// description (`named`), but nothing is required.
// Keywords are limited to what packages/protocol/schema.ts implements (type, enum, properties, required, items).

type Schema = Record<string, unknown>;
export type OutputSchema = {
  /** Names this exact schema (tool + content hash), so a client compiles its validator once, not after every tools/list. */
  $id: string;
  type: "object";
  properties: Record<string, Schema>;
  required: string[];
};

/** A list of every member of a string union; tsc fails when the union gains a member the list lacks. */
const every =
  <T extends string>() =>
  <const A extends readonly T[]>(members: A & ([T] extends [A[number]] ? unknown : never)): readonly T[] =>
    members;
const keys = <K extends string>(table: Record<K, unknown>): K[] => Object.keys(table) as K[];

const ERROR_CODES = every<ErrorCode>()([
  "unknown_robot",
  "unknown_device",
  "unknown_channel",
  "unknown_command",
  "unsupported",
  "robot_offline",
  "busy",
  "illegal_state",
  "invalid_argument",
  "fault",
  "timeout",
  "stop_unverified",
  "stale_image",
  "condition_unreadable",
  "internal",
  "misconfigured",
]);
const STOP_REASONS = every<StopReason>()(["completed", "condition_met", "timeout", "clamped", "stalled", "preempted"]);
const BACKENDS = every<BackendKind>()(["ev3", "sim"]);

const str = { type: "string" } as const;
const num = { type: "number" } as const;
const bool = { type: "boolean" } as const;
const strings = { type: "array", items: str } as const;
const nullable = (type: string, extra: Schema = {}): Schema => ({ type: [type, "null"], ...extra });
const oneOf = (values: readonly string[]): Schema => ({ type: "string", enum: [...values] });
/** A string whose expected values are documented, not enforced (runtime-produced data). */
const named = (values: readonly string[], note = ""): Schema => ({
  type: "string",
  description: `${values.join(" | ")}${note ? `. ${note}` : ""}`,
});
const obj = (properties: Record<string, Schema>, required: string[] = [], description?: string): Schema => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  ...(required.length ? { required } : {}),
});
const list = (items: Schema, description?: string): Schema => ({
  type: "array",
  ...(description ? { description } : {}),
  items,
});
const freeform = (description: string): Schema => ({ type: "object", description });

const activity = oneOf(keys(ACTIVITY_TRANSITIONS));
const stateFields = {
  id: str,
  backend: { type: ["string", "null"], enum: [...BACKENDS, null], description: "null while the robot is offline" },
  link: oneOf(keys(LINK_TRANSITIONS)),
  activity,
};
const robotState = obj(
  stateFields,
  Object.keys(stateFields),
  "Robot state after the call. Absent for tools that address no robot.",
);
const toolError = obj(
  {
    code: oneOf(ERROR_CODES),
    message: str,
    retryable: bool,
    retry_after_ms: num,
    measured: {
      type: "object",
      description: "What a move had done when the error ended it; the robot was stopped there.",
    },
  },
  ["code", "message", "retryable"],
  "Present when ok is false.",
);

/** The envelope around one tool's data (CONTRACT §7). One schema covers success and failure: check `ok`. */
const envelope = (data: Schema): Omit<OutputSchema, "$id"> => ({
  type: "object",
  properties: {
    ok: { type: "boolean", description: "true → data is present; false → error is present." },
    robot: robotState,
    data,
    error: toolError,
    next: list(str, "Suggested next tools."),
  },
  required: ["ok", "next"],
});

const reading = obj(
  {
    device: str,
    channel: str,
    value: {
      type: ["number", "boolean", "string", "array", "null"],
      description: "null when the read failed (see error) or the channel is an image.",
    },
    unit: str,
    ts: { type: "number", description: "Capture time, ms." },
    error: { type: "string", description: "Present when the channel could not be read; value is then null." },
    image: { type: "boolean", description: "true on an image channel: the picture is the result's image block." },
    mime: str,
    age_ms: { type: "number", description: "Age of an image channel's frame, ms." },
    absent: {
      type: "boolean",
      description:
        "true → value is null because the device answered that it has nothing to report (no beacon in view), not because the read failed.",
    },
  },
  [],
  "One channel value.",
);
const readings = list(reading);
const commandResult = obj({
  requested: freeform("What was asked."),
  applied: freeform("What was sent after clamping to the limits."),
  measured: freeform(
    "What happened. drive, turn and arc give the same fields: distance_cm, heading_change_deg, source (gyro | encoders: where the heading comes from), left_deg and right_deg (wheel rotation). command_device gives what the command's device reports.",
  ),
  clamped: bool,
  reason: named(STOP_REASONS, "Anything but completed or condition_met means the request was not fully done."),
  readings: list(
    reading,
    "Present when reason is condition_met: the readings that met the until condition, the shape read_all returns.",
  ),
  problem: { type: "string", description: "Present when the motion went wrong, e.g. a wheel turned backwards." },
  chunks: num,
  ms: num,
});
const deviceFields = { id: str, provider: str, kind: str, roles: strings, description: str };
const channelSpec = obj({
  name: str,
  type: named(["number", "boolean", "string", "vector", "image"]),
  unit: str,
  range: list(num),
  length: num,
  max_rate_hz: num,
  approx: str,
  mode_group: str,
  active: { type: "boolean", description: "false → reading it needs a mode switch: name it in channels." },
  null_when_absent: {
    type: "boolean",
    description:
      "true → the channel may read null with absent:true (nothing in view): an answer, not a failure. A condition on it is then not met, never condition_unreadable.",
  },
  description: str,
});
const commandSpec = obj({
  name: str,
  description: str,
  params: freeform("JSON Schema of the command's args."),
  bound: obj({ kind: named(["degrees", "ms", "instant"]), params: strings, max: num }),
  moves: bool,
});
const DATA: Record<string, Schema> = {
  list_robots: obj(
    {
      robots: list(
        obj(
          {
            ...stateFields,
            fault_reason: nullable("string"),
            connect: nullable("string", {
              description: "What a person must do to bring an offline robot online, e.g. the page to open.",
            }),
          },
          Object.keys(stateFields),
        ),
      ),
    },
    ["robots"],
  ),
  describe_robot: obj({
    id: str,
    backend: named(BACKENDS),
    devices: list(
      obj({ ...deviceFields, channels: list(str, "Channel names."), commands: list(str, "Command names.") }),
    ),
    roles: { type: "object", additionalProperties: str, description: "role → device id" },
    drivetrain: nullable("object", { description: "null → drive, turn and arc are unsupported." }),
    limits: obj({
      max_speed_pct: num,
      max_command_ms: num,
      max_drive_cm: num,
      max_turn_deg: num,
      max_program_ms: num,
    }),
    notes: strings,
    scan_error: nullable("string", {
      description:
        "null when the device list is current. Else why the latest device scan failed; the list is then the one of the last scan that succeeded.",
    }),
  }),
  describe_device: obj({ ...deviceFields, channels: list(channelSpec), commands: list(commandSpec) }),
  read_device: obj({ readings }),
  read_all: obj({ readings, ms: num }),
  sample_device: obj({
    samples: list({ type: "array" }, "[t_ms, value] pairs."),
    min: nullable("number"),
    max: nullable("number"),
    mean: nullable("number"),
    last: nullable("number"),
    rate_hz: num,
    unit: str,
    reason: { type: "string", description: '"preempted" when a stop cut the sampling short.' },
  }),
  wait_until: obj({ met: bool, reason: named(["condition_met", "timeout", "preempted"]), ms: num, readings }),
  drive: commandResult,
  turn: commandResult,
  arc: commandResult,
  command_device: commandResult,
  stop: obj({ motors_stopped: bool, activity }, ["motors_stopped"]),
  reset_fault: obj({ activity: named(["idle"]) }),
  run_program: obj({
    outcome: named(["succeeded", "failed", "aborted", "timeout"]),
    reason: str,
    steps: list(
      obj({
        path: str,
        tool: str,
        ok: bool,
        reason: str,
        error: obj({ code: named(ERROR_CODES), message: str }),
        ms: num,
      }),
    ),
    steps_dropped: num,
    ms: num,
  }),
};

/** FNV-1a (32 bit) of a string, as 8 hex characters. Names a schema by its content; not a security hash. */
function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Why `$id`: MCP clients compile a validator per outputSchema and keep it by `$id` when there is one. Without it
// they compile all of them again after every tools/list (about 35 ms for this catalog with Ajv), and the first
// tool call after each listing pays for it. The hash changes with the schema, so a client never keeps a stale one.
const withOutput = (t: Omit<ToolDef, "output">, schema: Omit<OutputSchema, "$id">): ToolDef => ({
  ...t,
  output: { $id: `urn:${SERVER_NAME}:local:output:${t.name}:${contentHash(JSON.stringify(schema))}`, ...schema },
});
/** The catalog, served verbatim by apps/local; `output` is the envelope around the tool's `data`. */
export const TOOLS: ToolDef[] = CATALOG.map((t) => {
  const data = DATA[t.name];
  if (!data) throw new Error(`tools.ts: ${t.name} has no output schema`);
  return withOutput(t, envelope(data));
});
