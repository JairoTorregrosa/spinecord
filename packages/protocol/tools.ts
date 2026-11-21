// The agent-facing MCP surface. Single source for tool names, descriptions and input schemas.
// The relay serves these verbatim (tools/list) and validates inputs against `input` before anything else.
// Writing rules: first sentence = what it does and what it returns. Then: when to use, preconditions,
// postconditions, units, failure codes. No use-case names. Everything a caller needs is here or in
// describe_robot / describe_device output.

export const SERVER_NAME = "spinecord";
export const SERVER_VERSION = "2.0.0";

export const SERVER_INSTRUCTIONS = `Controls physical robots (for example LEGO EV3 bricks) and their simulated twins, plus any external device attached to a robot (a phone camera, a microcontroller with sensors). The tool set is fixed and generic: a robot is a set of devices; each device describes its readable channels and its bounded commands.

How to work:
1. list_robots, then describe_robot to learn devices, roles, drivetrain, limits and notes. describe_device gives one device's full channel and command schemas.
2. Prefer the drivetrain tools (drive, turn, arc) for motion. Use command_device for any other actuator. Every command is bounded (degrees, milliseconds or instant) and clamped to the robot's limits; nothing runs open-ended.
3. Close the loop: after acting, read_device / read_all / sample_device, or look through a camera device (read_device on an image channel). Compare requested vs measured in every result; physical robots slip.
4. To react to the world inside one action, pass an \`until\` condition; to wait without moving, use wait_until.
5. Test on the twin first. Each robot "<id>" has a twin "<id>-sim" with the same devices plus a "sim.world" device. Programs (save_program, verify_program, run_program) must pass on the twin before they run on hardware.
6. Call stop the moment something looks wrong. stop never waits behind another call.

Every result is JSON: {ok, robot:{id, backend, link, activity, control, episode}, data | error:{code, message, retryable, retry_after_ms?}, next:[suggested tools]}. Errors are never disguised as data; a missing value is null with an error string. Mutating tools take request_id: reuse it to retry safely (the robot will not act twice). Units: cm, degrees (positive = counter-clockwise), speed in percent of max, time in ms.`;

const robotId = { type: "string", description: 'Robot id from list_robots, e.g. "t3" or its twin "t3-sim".' } as const;
const requestId = {
  type: "string",
  maxLength: 64,
  description:
    "Caller-chosen idempotency key, unique per intended action. Retrying the same tool with the same request_id and the same arguments returns the stored result instead of acting again (kept 10 min). Reusing a request_id with different arguments fails with invalid_argument: use a new id for a new action.",
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
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  scope: "user" | "admin";
  mutating: boolean; // true → requires request_id, control, activity checks
}

const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const act = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const meta = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS: ToolDef[] = [
  // ---------- Discovery ----------
  {
    name: "list_robots",
    title: "List robots",
    scope: "user",
    mutating: false,
    annotations: ro,
    description:
      "Lists the robots this token can see, with their state. Returns [{id, backend (ev3|sim), link (offline|handshaking|online), activity (idle|acting|stopping|running_program|fault), control (owner|admin), episode, battery_low (true when a battery device reports low; null before first connection)}]. backend is null until the robot has connected once.. Start here. A user token sees the robots assigned to it (typically a robot and its twin); an admin token sees all.",
    input: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "describe_robot",
    title: "Describe robot",
    scope: "user",
    mutating: false,
    annotations: ro,
    description:
      "Returns everything needed to use one robot: devices (id, kind, roles, channel names, command names), roles (role → device id), drivetrain (wheel geometry, or null if the robot cannot drive), limits (max speed, max command ms, max drive cm, max turn deg, max program ms), notes (facts about how it is built) and current state. Call before acting and again after an error mentioning unknown_device, since attached devices can come and go.",
    input: { type: "object", properties: { robot_id: robotId }, required: ["robot_id"], additionalProperties: false },
  },
  {
    name: "describe_device",
    title: "Describe device",
    scope: "user",
    mutating: false,
    annotations: ro,
    description:
      "Returns one device's full spec: every channel (name, type number|boolean|string|vector|image, unit, range, max_rate_hz, accuracy note) and every command (name, description, JSON Schema of params, bound kind degrees|ms|instant and its max, whether it moves). Use it before command_device on a device you have not used, and to discover what an attached device can do.",
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
    scope: "user",
    mutating: false,
    annotations: ro,
    description:
      "Reads current values of one device's channels. Returns [{device, channel, value, unit, ts, error?}]. Reading never changes the device: omit channels to read its active channels; channels that need a sensor mode switch (active:false in describe_device) come back null with error mode_switch_required. Name such a channel explicitly in `channels` to switch the mode (only while the robot is idle; side effects are described per channel, e.g. switching the EV3 gyro resets its angle). Requesting an image channel (e.g. a camera's \"frame\") returns the picture as an image content block plus {age_ms}; frames older than 1500 ms fail with stale_image. Works in any activity state while the robot is online.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        device: { type: "string", description: "Device id or role." },
        channels: {
          type: "array",
          items: { type: "string" },
          description: "Channel names. Omit for all non-image channels.",
        },
      },
      required: ["robot_id", "device"],
      additionalProperties: false,
    },
  },
  {
    name: "read_all",
    title: "Read all sensors",
    scope: "user",
    mutating: false,
    annotations: ro,
    description:
      "Reads every active non-image channel of every device in one call, without changing any device (no mode switches). Returns {readings:[{device, channel, value, unit, ts, error?}], ms}. Cheapest way to see the whole robot's state after an action.",
    input: { type: "object", properties: { robot_id: robotId }, required: ["robot_id"], additionalProperties: false },
  },
  {
    name: "sample_device",
    title: "Sample channel over time",
    scope: "user",
    mutating: false,
    annotations: ro,
    description:
      "Samples one numeric channel repeatedly and returns {samples:[[t_ms, value]...], min, max, mean, last}. rate_hz is capped by the channel's max_rate_hz and 50; duration_ms ≤ 5000. Use it to see trends (is the distance shrinking? is the color stable?) rather than calling read_device in a loop.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        device: { type: "string" },
        channel: { type: "string" },
        rate_hz: { type: "number", minimum: 1, maximum: 50 },
        duration_ms: { type: "integer", minimum: 100, maximum: 5000 },
      },
      required: ["robot_id", "device", "channel", "duration_ms"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_until",
    title: "Wait for condition",
    scope: "user",
    mutating: false,
    annotations: ro,
    description:
      "Waits without moving until a condition over device channels becomes true or timeout_ms passes (≤ 10000). Returns {met: boolean, after_ms, readings (values that decided it)}. Not an error when the timeout passes: check met. Use for waiting on a button, a person, a light change.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        condition,
        timeout_ms: { type: "integer", minimum: 50, maximum: 10000 },
        poll_hz: { type: "number", minimum: 1, maximum: 50 },
      },
      required: ["robot_id", "condition", "timeout_ms"],
      additionalProperties: false,
    },
  },

  // ---------- Acting ----------
  {
    name: "drive",
    title: "Drive straight",
    scope: "user",
    mutating: true,
    annotations: act,
    description:
      "Drives straight by distance_cm (negative = backwards) using the robot's drivetrain, then brakes. Returns {requested:{distance_cm, speed_pct}, measured:{distance_cm, heading_change_deg}, clamped, reason, ms}; reason ∈ completed | condition_met | clamped | stalled | preempted | timeout. With `until`, stops early when the condition becomes true (reason condition_met) and distance_cm is then the maximum. Measured values come from wheel encoders, not the request. Requires: online, idle, in control, a drivetrain (else unsupported). Clamped to max_drive_cm.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        distance_cm: { type: "number" },
        speed_pct: speed,
        until: condition,
        request_id: requestId,
      },
      required: ["robot_id", "distance_cm", "request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "turn",
    title: "Turn in place",
    scope: "user",
    mutating: true,
    annotations: act,
    description:
      "Rotates in place by angle_deg (positive = counter-clockwise/left, negative = right), then brakes. Returns {requested:{angle_deg}, measured:{angle_deg (gyro if present, else encoders), source}, clamped, reason, ms}. Supports `until` like drive. Requires a drivetrain. Clamped to max_turn_deg.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        angle_deg: { type: "number" },
        speed_pct: speed,
        until: condition,
        request_id: requestId,
      },
      required: ["robot_id", "angle_deg", "request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "arc",
    title: "Drive along an arc",
    scope: "user",
    mutating: true,
    annotations: act,
    description:
      "Drives along a circular arc, then brakes. radius_cm (> 0) is measured to the robot's center. angle_deg is the heading change: positive = curve left (counter-clockwise), negative = curve right. direction forward (default) or backward. Example: a quarter circle to the right while moving forward = {radius_cm: 20, angle_deg: -90}. Returns the same shape as drive with measured distance and heading change. Supports `until`. Requires a drivetrain.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        radius_cm: { type: "number", exclusiveMinimum: 0 },
        angle_deg: { type: "number" },
        direction: { type: "string", enum: ["forward", "backward"] },
        speed_pct: speed,
        until: condition,
        request_id: requestId,
      },
      required: ["robot_id", "radius_cm", "angle_deg", "request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "command_device",
    title: "Command a device",
    scope: "user",
    mutating: true,
    annotations: act,
    description:
      "Runs one named command on one device, e.g. a motor's run_degrees, a speaker's tone, a display's text, a servo's set_angle, the twin's sim.world load_world. Args must match the command's params schema from describe_device. Every command is bounded (bound.kind degrees|ms|instant) and clamped; returns {requested, measured, clamped, reason, ms}. Supports `until` for commands that move. Commands that move require idle and control; instant non-moving commands (sound, display, light) only require control.",
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
      required: ["robot_id", "device", "command", "request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "stop",
    title: "Stop robot",
    scope: "user",
    mutating: false,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      "Immediately brakes every actuator and aborts any running command or program, without waiting behind it. Returns {motors_stopped: boolean, activity}. If the stop cannot be verified the robot enters fault. Allowed in any state and for any token that can see the robot, even without control. Use whenever something looks wrong.",
    input: { type: "object", properties: { robot_id: robotId }, required: ["robot_id"], additionalProperties: false },
  },
  {
    name: "reset_fault",
    title: "Clear fault",
    scope: "user",
    mutating: true,
    annotations: meta,
    description:
      'Leaves the fault state after verifying all motors are stopped. Returns {activity: "idle"} or fails with stop_unverified. Only valid in fault. Read the robot (read_all) and its last error first; a fault means a stop could not be confirmed, a motor stalled repeatedly, the battery is low, or the brick\'s page reported an error.',
    input: {
      type: "object",
      properties: { robot_id: robotId, request_id: requestId },
      required: ["robot_id", "request_id"],
      additionalProperties: false,
    },
  },

  // ---------- Programs ----------
  {
    name: "save_program",
    title: "Save program",
    scope: "user",
    mutating: true,
    annotations: meta,
    description:
      "Saves a reusable behavior as data (no code) in the shared library; returns the stored program with version and state draft. body is a tree of nodes: {seq:[...]}, {repeat:{times≤50, body}}, {while:{cond, body, max_iterations≤200}}, {if:{cond, then, else?}}, {call:{tool: drive|turn|arc|command_device|wait_until, args}}, {wait_ms≤10000}, {succeed:msg}, {fail:msg}. Args inside calls omit robot_id and request_id. Optional success condition is checked at the end. Saving an existing name creates a new version.",
    input: {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[a-z0-9_]{2,48}$" },
        description: { type: "string", maxLength: 500 },
        body: { type: "object" },
        success: condition,
        pass_rate: { type: "number", minimum: 0.5, maximum: 1 },
        request_id: requestId,
      },
      required: ["name", "description", "body", "request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_programs",
    title: "List programs",
    scope: "user",
    mutating: false,
    annotations: ro,
    description:
      "Lists programs in the shared library: [{name, version, description, state (draft|verified|needs_review|approved|retired), success_rate, requires, author}]. Filter with query (substring of name or description) and state. Reuse what others built before writing your own.",
    input: {
      type: "object",
      properties: {
        query: { type: "string" },
        state: { type: "string", enum: ["draft", "verified", "needs_review", "approved", "retired"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_program",
    title: "Get program",
    scope: "user",
    mutating: false,
    annotations: ro,
    description:
      "Returns one program's full body, success condition, state and verification history. Omit version for the latest.",
    input: {
      type: "object",
      properties: { name: { type: "string" }, version: { type: "integer" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_program",
    title: "Verify program on twin",
    scope: "user",
    mutating: true,
    annotations: act,
    description:
      "Runs a program `trials` times (1–20) on a twin robot (backend sim), resetting the twin between trials, and returns {success_rate, outcomes:[{trial, outcome, reason, ms}], state}. success_rate ≥ pass_rate moves draft → verified and records verified_on {twin_id, profile_hash}; a hardware robot runs it only if its profile_hash matches (same drivetrain, roles and limits), else program_not_runnable. If the program uses a device the twin cannot simulate, it moves to needs_review instead and an admin must approve it before it can run on hardware.",
    input: {
      type: "object",
      properties: {
        name: { type: "string" },
        version: { type: "integer" },
        robot_id: { ...robotId, description: "A twin robot id ending in -sim." },
        trials: { type: "integer", minimum: 1, maximum: 20 },
        request_id: requestId,
      },
      required: ["name", "robot_id", "trials", "request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "run_program",
    title: "Run program",
    scope: "user",
    mutating: true,
    annotations: act,
    description:
      "Runs a saved program on a robot and waits for it. Returns {outcome: succeeded|failed|aborted|timeout, steps:[{path, tool, ok, reason|error, ms}], ms}. On a hardware robot the program must be verified or approved (else program_not_runnable); on a twin any non-retired program runs. Activity is running_program until it ends; stop aborts it. Total time is capped by max_program_ms.",
    input: {
      type: "object",
      properties: { robot_id: robotId, name: { type: "string" }, version: { type: "integer" }, request_id: requestId },
      required: ["robot_id", "name", "request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "retire_program",
    title: "Retire program",
    scope: "user",
    mutating: true,
    annotations: meta,
    description:
      "Marks a program version retired so it can no longer run. Only its author or an admin. Returns the program.",
    input: {
      type: "object",
      properties: { name: { type: "string" }, version: { type: "integer" }, request_id: requestId },
      required: ["name", "version", "request_id"],
      additionalProperties: false,
    },
  },

  // ---------- Episodes (generic run recording) ----------
  {
    name: "start_episode",
    title: "Start episode",
    scope: "user",
    mutating: true,
    annotations: meta,
    description:
      "Starts recording an episode on a robot: from now until end_episode, every call, stop and error is counted. Returns the episode {id, label, state: running}. Use it to measure an attempt at any goal (time taken, how many corrections). Fails with illegal_state if one is already running.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        label: { type: "string", maxLength: 200 },
        tags: { type: "array", items: { type: "string" } },
        request_id: requestId,
      },
      required: ["robot_id", "label", "request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mark_episode",
    title: "Mark episode",
    scope: "user",
    mutating: true,
    annotations: meta,
    description:
      'Adds a timestamped mark to the running episode, e.g. kind "intervention" when a person touched the robot, "checkpoint" when a sub-goal was reached. Returns the episode summary so far.',
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        kind: { type: "string", maxLength: 40 },
        note: { type: "string", maxLength: 500 },
        request_id: requestId,
      },
      required: ["robot_id", "kind", "request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "end_episode",
    title: "End episode",
    scope: "user",
    mutating: true,
    annotations: meta,
    description:
      "Ends the running episode with a free-form outcome and optional numeric metrics, and returns the summary {elapsed_ms, calls, moving_calls, stops, errors, marks, outcome, metrics}.",
    input: {
      type: "object",
      properties: {
        robot_id: robotId,
        outcome: { type: "string", maxLength: 40 },
        metrics: { type: "object", additionalProperties: { type: "number" } },
        request_id: requestId,
      },
      required: ["robot_id", "outcome", "request_id"],
      additionalProperties: false,
    },
  },

  // ---------- Admin ----------
  {
    name: "take_control",
    title: "Take control",
    scope: "admin",
    mutating: true,
    annotations: meta,
    description:
      "Admin only. Stops the robot and moves control from its owner to the admin; the owner can still read but its acting tools fail with not_in_control. Returns {control}.",
    input: {
      type: "object",
      properties: { robot_id: robotId, request_id: requestId },
      required: ["robot_id", "request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "release_control",
    title: "Release control",
    scope: "admin",
    mutating: true,
    annotations: meta,
    description: "Admin only. Stops the robot and gives control back to its owner. Returns {control}.",
    input: {
      type: "object",
      properties: { robot_id: robotId, request_id: requestId },
      required: ["robot_id", "request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_all",
    title: "Stop all robots",
    scope: "admin",
    mutating: false,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Admin only. Stops every online robot this deployment serves. Returns [{robot_id, motors_stopped}].",
    input: { type: "object", properties: {}, additionalProperties: false },
  },
];
