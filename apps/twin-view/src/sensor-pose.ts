// Where the distance sensor (ultrasonic or infrared) is and where it looks: one pose that the physics reads from,
// the page draws the sensor at, and the page draws the rays from. The pose is the robot's `body` after
// apps/local/src/twin-build.ts has resolved it (`resolveDistancePose`): its eye's point, x cm ahead of the axle,
// y cm to the left, z cm up, and the heading it looks along, yaw degrees counter-clockwise from ahead. The eye is
// the part's own point in the LEGO parts map: the infrared's front face, the ultrasonic's beam centre.
//
// A look's place (`twin.view.sensors.<n>`) is the centre of the part's box (look.ts); this file turns one into the
// other. No three.js and no parts map here: apps/local reads it too, handing in the part's box from the map it reads
// at run time (apps/local/src/sensor-eyes.ts), the page from dims.ts.
import type { Facing, Place } from "./look";

export type DistanceKind = "ultrasonic" | "ir";
export const isDistance = (kind: string): kind is DistanceKind => kind === "ultrasonic" || kind === "ir";

/** The distance sensor's eye and heading, robot frame (x ahead, y left, z up), cm and degrees. */
export interface SensorPose {
  x_cm: number;
  y_cm: number;
  z_cm: number;
  yaw_deg: number;
}

const EYE: Record<DistanceKind, string> = { ultrasonic: "beam_centre", ir: "front_face" };
const DEG = Math.PI / 180;

/** A sensor's box and named points in its own frame (x where it looks, y left, z up), cm: dims.ts PartDims. */
export interface PartBox {
  min: readonly number[];
  max: readonly number[];
  at: Record<string, readonly number[]>;
}
/** The eye from the centre of the part's box, in the part's frame (x where it looks, y left, z up), cm. */
export type EyeOffset = [number, number, number];

/** Where a sensor's eye is from the centre of its box. */
export function eyeOffset(kind: DistanceKind, part: PartBox): EyeOffset {
  const e = part.at[EYE[kind]];
  if (!e) throw new Error(`the parts map gives the ${kind} sensor no ${EYE[kind]}`);
  const c = (i: number) => (part.min[i]! + part.max[i]!) / 2;
  return [e[0]! - c(0), e[1]! - c(1), e[2]! - c(2)];
}

/** The heading of a facing turned by yaw_deg, degrees in -180..180; null for up and down (no heading). */
export function facingYaw(facing: Facing | null, yawDeg: number): number | null {
  const base = { forward: 0, left: 90, back: 180, right: -90, up: null, down: null }[facing ?? "forward"];
  return base === null ? null : wrapDeg(base + yawDeg);
}
/** An angle in degrees, turned into -180..180 (180, not -180). */
export const wrapDeg = (d: number): number => {
  const w = (((d % 360) + 540) % 360) - 180;
  return w === -180 ? 180 : w;
};

/** Where the centre of the part's box is when its eye is at `pose`: the place the look draws it at. */
export function centreForPose(eye: EyeOffset, pose: SensorPose): { x: number; y: number; z: number } {
  const [ox, oy, oz] = eye;
  const c = Math.cos(pose.yaw_deg * DEG),
    s = Math.sin(pose.yaw_deg * DEG);
  return { x: pose.x_cm - (ox * c - oy * s), y: pose.y_cm - (ox * s + oy * c), z: pose.z_cm - oz };
}

/**
 * What a look's place says of the eye: each of x, y, z, yaw it settles, null where it is silent. The eye's x and y
 * need the part's centre on that axis and its heading (the eye sits ahead of the centre); with no facing and no
 * yaw_deg the part faces forward, as the look draws it.
 */
export function eyeOfPlace(
  offset: EyeOffset,
  p: Place,
  stated: { facing: boolean; yaw: boolean },
): { x: number | null; y: number | null; z: number | null; yaw: number | null } {
  // up and down have no heading the physics can read along: refused, naming the facing (the caller names the place)
  const yaw = facingYaw(p.facing, p.yaw);
  if (yaw === null)
    throw new Error(
      `faces ${p.facing}: a distance sensor reads level, along a heading; give it "facing" forward, back, left or right (and "yaw_deg" to turn it between them)`,
    );
  const [ox, oy, oz] = offset;
  const c = Math.cos(yaw * DEG),
    s = Math.sin(yaw * DEG);
  return {
    x: p.x === null ? null : p.x + ox * c - oy * s,
    y: p.y === null ? null : p.y + ox * s + oy * c,
    z: p.z === null ? null : p.z + oz,
    yaw: stated.facing || stated.yaw ? yaw : null,
  };
}

/** How far a place may put the eye from the pose the body states before the file is refused: cm, degrees. */
export const POSE_TOLERANCE = { cm: 0.5, deg: 1 };

/** The body fields of the pose, in the order x, y, z, yaw. */
export const POSE_FIELDS = {
  x: "distance_sensor_x_cm",
  y: "distance_sensor_y_cm",
  z: "distance_sensor_z_cm",
  yaw: "distance_sensor_yaw_deg",
} as const;

/**
 * The pose the physics and the page use, from what the robot's body states and what its look's place says of the
 * eye: each component from the body where the body states it, else from the place, else the default. The body
 * wins for x and z (a measured number; a look's box centre sits a few cm behind and below the eye); y and yaw,
 * stated by both, must agree (POSE_TOLERANCE), else this throws naming both, so a file cannot draw the sensor
 * where it does not read.
 */
export function resolveDistancePose(
  body: Partial<Record<(typeof POSE_FIELDS)[keyof typeof POSE_FIELDS], number>>,
  eye: { x: number | null; y: number | null; z: number | null; yaw: number | null } | null,
  defaults: SensorPose,
  where: { body: string; place: string },
): SensorPose {
  const r1 = (v: number) => Math.round(v * 100) / 100;
  const pick = (k: keyof typeof POSE_FIELDS, d: number): number => {
    const b = body[POSE_FIELDS[k]],
      v = eye?.[k] ?? null;
    if (b !== undefined && v !== null && (k === "y" || k === "yaw")) {
      const off = k === "yaw" ? Math.abs(wrapDeg(b - v)) : Math.abs(b - v);
      if (off > (k === "yaw" ? POSE_TOLERANCE.deg : POSE_TOLERANCE.cm))
        throw new Error(
          `${where.place} puts the distance sensor's eye at ${POSE_FIELDS[k]} ${r1(v)}, and ${where.body}.${POSE_FIELDS[k]} is ${b}: the twin reads from one place and would be drawn at another. Write the same ${k === "yaw" ? "direction" : "side"} in both, or leave one out`,
        );
    }
    return b ?? (v === null ? d : r1(v));
  };
  return {
    x_cm: pick("x", defaults.x_cm),
    y_cm: pick("y", defaults.y_cm),
    z_cm: pick("z", defaults.z_cm),
    yaw_deg: pick("yaw", defaults.yaw_deg),
  };
}

/** The pose a parsed body carries. */
export const poseOfBody = (b: {
  distance_sensor_x_cm: number;
  distance_sensor_y_cm: number;
  distance_sensor_z_cm: number;
  distance_sensor_yaw_deg: number;
}): SensorPose => ({
  x_cm: b.distance_sensor_x_cm,
  y_cm: b.distance_sensor_y_cm,
  z_cm: b.distance_sensor_z_cm,
  yaw_deg: b.distance_sensor_yaw_deg,
});

/** The ports' distance sensor the pose belongs to: the lowest port with an ultrasonic or infrared; null for none. */
export function distancePort<P extends string>(
  sensors: Partial<Record<P, string>>,
): { port: P; kind: DistanceKind } | null {
  const ports = (Object.keys(sensors) as P[]).filter((p) => isDistance(sensors[p] ?? "")).sort();
  return ports.length ? { port: ports[0]!, kind: sensors[ports[0]!] as DistanceKind } : null;
}

/** The end of a ray of `cm` along bearing `deg` (from the sensor's heading, left positive), three.js robot frame
 *  (x ahead, y up, z to the right). */
export function rayEnd(from: SensorPose, deg: number, cm: number): [number, number, number] {
  const a = (from.yaw_deg + deg) * DEG;
  return [from.x_cm + Math.cos(a) * cm, from.z_cm, -(from.y_cm + Math.sin(a) * cm)];
}
/** Where every ray starts, three.js robot frame. */
export const rayStart = (from: SensorPose): [number, number, number] => [from.x_cm, from.z_cm, -from.y_cm];
