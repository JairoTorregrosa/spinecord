// The imu kind (CONTRACT §2.3): tilt, compass heading, acceleration and rotation rate from the browser's
// DeviceOrientation and DeviceMotion events, all pushed from those events, at most 20 times per second. A channel
// is declared once the browser has sent a sample that carries it: a desktop browser has the event types and no
// sensor behind them, and then the imu is not lent. While the page is hidden a browser sends no motion events, so
// the device is down until the page is visible again.
import type { ChannelSpec, Scalar } from "../../../../packages/protocol/types";
import type { MotionEventLike, MotionEventType, OrientationEventLike, Win } from "../browser";
import type { DeviceDef, Kit } from "../kit";

export const IMU_PUSH_MS = 50;
/** After the first motion sample the tap waits this long for the other event types' first samples. */
export const IMU_SETTLE_MS = 100;
/** A jolt above this (m/s², gravity left out) makes `shaken` true for SHAKE_HOLD_MS. */
export const SHAKE_M_S2 = 15;
export const SHAKE_HOLD_MS = 1000;
const G = 9.80665;

/** An angle in degrees in [-180, 180). */
export const wrap180 = (deg: number): number => ((((deg + 180) % 360) + 360) % 360) - 180;
const round = (v: number, k = 10) => Math.round(v * k) / k;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Heading counter-clockwise from north (CONTRACT §2.2), or null when the browser gives no absolute orientation. */
export function headingOf(ev: OrientationEventLike, absoluteEvent: boolean): number | null {
  if (num(ev.webkitCompassHeading)) return round(wrap180(-ev.webkitCompassHeading));
  if ((absoluteEvent || ev.absolute === true) && num(ev.alpha)) return round(wrap180(ev.alpha));
  return null;
}

const ch = (name: string, unit: string, description: string, extra: Partial<ChannelSpec> = {}): ChannelSpec => ({
  name,
  type: "number",
  unit,
  pushed: true,
  max_rate_hz: 20,
  description,
  ...extra,
});
const TILT: ChannelSpec[] = [
  ch("pitch_deg", "deg", "Front-to-back tilt: 0 lying flat, positive with the top edge raised, 90 upright."),
  ch("roll_deg", "deg", "Left-to-right tilt: 0 lying flat, positive with the right edge lowered."),
  ch(
    "heading_deg",
    "deg",
    "Compass heading of the top edge, counter-clockwise-positive from north; absent where the browser gives no compass.",
    { null_when_absent: true },
  ),
];
const ACCEL: ChannelSpec[] = ["x", "y", "z"].map((a) =>
  ch(
    `accel_${a}_m_s2`,
    "m/s2",
    `Acceleration along the device's ${a} axis, gravity included (flat, screen up: z about +9.8).`,
  ),
);
const RATE: ChannelSpec[] = ["x", "y", "z"].map((a) =>
  ch(`rate_${a}_deg_s`, "deg/s", `Rotation rate about the device's ${a} axis.`),
);
const SHAKEN: ChannelSpec = {
  name: "shaken",
  type: "boolean",
  pushed: true,
  max_rate_hz: 20,
  description: `true for ${SHAKE_HOLD_MS} ms after a jolt above ${SHAKE_M_S2} m/s2.`,
};

export interface ImuOptions {
  kit: Kit;
  win: Win;
  /** What the tap obtained for the motion sensors. */
  permission: true | { why: string };
  now: () => number;
}
export interface Imu {
  def: DeviceDef;
  /** Resolves once a sample with values came, or after ms. */
  ready(ms: number): Promise<void>;
  /** The page became visible or hidden. */
  visible(v: boolean): void;
  /** Stop lending: the listeners go. */
  close(): void;
}

export function imu(o: ImuOptions): Imu {
  const { kit, win } = o;
  const why = o.permission === true ? null : o.permission.why;
  const has = { tilt: false, accel: false, rate: false };
  let closed = false;
  let pending: Record<string, Scalar | null> = {};
  let lastPush = -Infinity;
  let jolt = -Infinity;
  let shaken = false;
  let compass = false; // a heading came once: a sample without one keeps it
  let waiting: (() => void)[] = [];

  const def: DeviceDef = {
    id: "imu",
    kind: "imu",
    description:
      "The motion sensors of this browser page's device: tilt, compass heading where it has one, acceleration and rotation rate, pushed as the device moves.",
    get channels() {
      return [...(has.tilt ? TILT : []), ...(has.accel ? [...ACCEL, SHAKEN] : []), ...(has.rate ? RATE : [])];
    },
    commands: [],
    available: () => {
      if (closed) return "the person stopped lending it";
      if (why) return why;
      if (!has.tilt && !has.accel && !has.rate)
        return "this device sent no motion sample: it has no motion sensors, or the browser gives the page none";
      return true;
    },
  };
  kit.device(def);

  const learn = (k: keyof typeof has) => {
    if (has[k]) return;
    has[k] = true;
    kit.announce();
    for (const w of waiting.splice(0)) w();
  };
  const emit = (values: Record<string, Scalar | null>) => {
    if (closed) return;
    Object.assign(pending, values);
    const t = o.now();
    if (t - lastPush < IMU_PUSH_MS) return;
    lastPush = t;
    const out = pending;
    pending = {};
    kit.push("imu", out);
  };

  const onOrientation = (absoluteEvent: boolean) => (ev: OrientationEventLike) => {
    if (!num(ev.beta) || !num(ev.gamma)) return;
    // an absolute event carries the heading alone when the page also has the relative one
    const heading = headingOf(ev, absoluteEvent);
    if (heading !== null) compass = true;
    learn("tilt");
    emit({
      pitch_deg: round(ev.beta),
      roll_deg: round(ev.gamma),
      ...(heading !== null || !compass ? { heading_deg: heading } : {}),
    });
  };
  const onMotion = (ev: MotionEventLike) => {
    const g = ev.accelerationIncludingGravity;
    const r = ev.rotationRate;
    const values: Record<string, Scalar> = {};
    if (g && num(g.x) && num(g.y) && num(g.z)) {
      learn("accel");
      const a = ev.acceleration;
      const linear =
        a && num(a.x) && num(a.y) && num(a.z) ? Math.hypot(a.x, a.y, a.z) : Math.abs(Math.hypot(g.x, g.y, g.z) - G);
      const t = o.now();
      if (linear > SHAKE_M_S2) jolt = t;
      shaken = t - jolt < SHAKE_HOLD_MS;
      Object.assign(values, {
        accel_x_m_s2: round(g.x, 100),
        accel_y_m_s2: round(g.y, 100),
        accel_z_m_s2: round(g.z, 100),
        shaken,
      });
    }
    if (r && num(r.alpha) && num(r.beta) && num(r.gamma)) {
      learn("rate");
      Object.assign(values, {
        rate_x_deg_s: round(r.beta),
        rate_y_deg_s: round(r.gamma),
        rate_z_deg_s: round(r.alpha),
      });
    }
    if (Object.keys(values).length) emit(values);
  };
  const listeners: [MotionEventType, (ev: OrientationEventLike & MotionEventLike) => void][] = [
    ["deviceorientation", onOrientation(false)],
    ["deviceorientationabsolute", onOrientation(true)],
    ["devicemotion", onMotion],
  ];
  if (!why) for (const [type, cb] of listeners) win.addEventListener?.(type, cb);

  return {
    def,
    ready(ms) {
      if (why) return Promise.resolve();
      // the first sample of each event type comes a moment apart: wait a little past the first one
      return new Promise((resolve) => {
        const cap = setTimeout(resolve, ms);
        const settle = () => setTimeout(() => (clearTimeout(cap), resolve()), IMU_SETTLE_MS);
        if (has.tilt || has.accel || has.rate) settle();
        else waiting.push(settle);
      });
    },
    visible(v) {
      if (v) kit.up("imu");
      else kit.down("imu", "the page is hidden: the browser sends it no motion events");
    },
    close() {
      closed = true;
      for (const [type, cb] of listeners) win.removeEventListener?.(type, cb);
    },
  };
}
