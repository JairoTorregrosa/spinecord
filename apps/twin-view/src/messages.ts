// The messages between apps/local's view listener (src/view.ts) and this page: one JSON object per WebSocket
// text frame. Units as in sim-world: cm and ms, degrees at the edges; x to the right, y up, headings
// counter-clockwise from +x seen from above.
import type { ChatServerMessage, ChatStatus } from "./chat-messages";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** A box on the floor as the world holds it (sim-world's Obstacle): a page names it by `id`, never by its place. */
export interface Obstacle extends Box {
  id: string;
  /** How tall it stands (cm); absent: taller than any sensor looks over. */
  height_cm?: number;
  /** Its mass (g): the robot can push it. Absent: fixed in place. */
  mass_g?: number;
  /** Infrared light it sends back, relative to a white wall (absent: 1). */
  ir_reflectivity?: number;
}

/** How a body looks: the `extensions.view` section of a world file, read by the page (src/look.ts). */
export type LookSection = Record<string, unknown> | null;

export interface WorldShape {
  name: string;
  width: number;
  height: number;
  boxes: Obstacle[];
  /** Coloured floor zones; `color` is the colour id of contract §2.2 (1 black … 7 brown). */
  zones: (Box & { color: number; label?: string })[];
  lines: { points: [number, number][]; width: number; closed: boolean }[];
  points: { label: string; x: number; y: number; radius: number }[];
  /** The footprint and where the sensors sit, measured from the centre of the wheel axle. */
  body: {
    front_cm: number;
    back_cm: number;
    half_width_cm: number;
    color_sensor_x_cm: number;
    color_spot_radius_cm: number;
    distance_sensor_x_cm: number;
    /** How high the distance sensor's beam is (cm above the floor). */
    distance_sensor_z_cm: number;
  };
  start: { x: number; y: number; heading_deg: number };
  look: LookSection;
}

export interface RobotMeta {
  id: string;
  /** The name the person gave the robot (its robot file's `name`, or --name); null when none. */
  name: string | null;
  drivetrain: {
    left: string;
    right: string;
    wheel_diameter_cm: number;
    axle_track_cm: number;
    forward_sign: 1 | -1;
  } | null;
  ports: {
    motors: Partial<Record<"A" | "B" | "C" | "D", "large" | "medium">>;
    sensors: Partial<Record<"1" | "2" | "3" | "4", "touch" | "color" | "ultrasonic" | "gyro" | "ir">>;
  };
  world: WorldShape;
}

export interface MotorState {
  port: "A" | "B" | "C" | "D";
  type: "large" | "medium" | null;
  tacho_deg: number;
  speed_pct: number;
  blocked: boolean;
  coasting: boolean;
}
export interface SensorState {
  port: "1" | "2" | "3" | "4";
  kind: "touch" | "color" | "ultrasonic" | "gyro" | "ir" | null;
  mode: number;
  /** SI values of the current mode without noise; [] for an empty or silent port. */
  values: number[];
}
export interface RobotState {
  id: string;
  pose: { x: number; y: number; heading_deg: number };
  /** The last physics step was blocked by a wall or obstacle. */
  stalled: boolean;
  link: string;
  activity: string;
  motors: MotorState[];
  sensors: SensorState[];
  led: number;
  lcd: string[];
  battery_v: number;
  battery_pct: number;
  buttons: number[];
  /** True length of the three rays of the distance sensor's cone (right, centre, left), cm, not clamped. */
  rays_cm: [number, number, number];
  /** Simulated time of the world, ms. */
  t_ms: number;
}

export interface CallStart {
  t: "call_start";
  n: number;
  /** When it began, ms since the epoch (the page and the process share a clock: both run on this computer). */
  at: number;
  tool: string;
  robot_id: string | null;
  /** The call's arguments as JSON, cut. */
  args: string;
}
export interface CallEnd {
  t: "call_end";
  n: number;
  /** When it ended, ms since the epoch. */
  at: number;
  tool: string;
  robot_id: string | null;
  ok: boolean;
  code: string | null;
  summary: string;
  ms: number;
}

export type ServerMessage =
  | {
      t: "hello";
      robots: RobotMeta[];
      rate_hz: number;
      calls: (CallStart | CallEnd)[];
      /** Only with --chat (chat-messages.ts): its status and what a page that opens late missed. */
      chat?: { status: ChatStatus; history: ChatServerMessage[] };
    }
  /** The world of a twin was replaced (sim.world load_world): rebuild everything of that robot. */
  | { t: "robot"; robot: RobotMeta }
  /** Only the obstacles changed (`rev`: the world's obstacles_rev): a push, a page, or sim.world. */
  | { t: "boxes"; id: string; rev: number; boxes: Obstacle[] }
  | { t: "state"; robots: RobotState[] }
  | { t: "tone"; id: string; hz: number; ms: number; volume: number }
  | { t: "speak"; id: string; text: string }
  | CallStart
  | CallEnd
  | ChatServerMessage
  | { t: "reply"; req: number; ok: true }
  /** An action refused, changing nothing: `code` says why for the page's own words, `error` in English. */
  | { t: "reply"; req: number; ok: false; code: RefusalCode; error: string };

/**
 * Why an action of the page was refused. does_not_fit: the robot would overlap a wall or a box there;
 * box_on_robot: the box would sit on the robot; outside: a box not inside the arena; no_such_box: that box is
 * gone (another page took it); too_fast: more actions than a hand makes; invalid: a malformed action;
 * internal: a fault of the view itself (the process logs it as view_error).
 */
export type RefusalCode =
  | "does_not_fit"
  | "box_on_robot"
  | "outside"
  | "no_such_box"
  | "too_fast"
  | "invalid"
  | "internal";

export type PageMessage =
  /** A person picks the robot up and sets it down (the gyro feels the turn). */
  | { t: "carry"; req: number; id: string; x: number; y: number; heading_deg: number }
  | { t: "box_add"; req: number; id: string; x: number; y: number; w: number; h: number }
  /** Box `box` (its id) taken away. */
  | { t: "box_remove"; req: number; id: string; box: string }
  /** Box `box` (its id) lifted and set down as `x, y, w, h`, keeping its id, height and mass. */
  | { t: "box_move"; req: number; id: string; box: string; x: number; y: number; w: number; h: number }
  /** The world's own obstacles back, and the robot at its start pose. */
  | { t: "restore"; req: number; id: string }
  /** A brick button (1 up, 2 enter, 3 down, 4 right, 5 left, 6 back) goes down or up. */
  | { t: "button"; req: number; id: string; button: number; down: boolean };
