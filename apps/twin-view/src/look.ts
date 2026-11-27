// How a twin's body looks in 3D: the optional `extensions.view` section of its world file. The parts themselves
// come from the robot's ports (which motor and which sensor is on each port) and its drivetrain (wheel diameter,
// axle track); this section only says how the person assembled them. Every field is optional: a missing or bad
// field takes its default, and the defaults always give a plausible robot whose parts do not overlap.
//
// Lengths in cm, from the centre of the drive axle on the floor: x ahead, y to the left, z up. A position is the
// centre of the part's box, except the brick's z, which is its bottom.
//
//   "view": {
//     "drive": "tracks" | "wheels" | "none"
//         tracks: wide tread links around two sprockets, as long as the world's body; wheels: two tyres with a
//         ball caster; none: no drive (a stationary arm). Default: wheels with a drivetrain, none without.
//     "caster": "ball" | "none"                         with wheels; default "ball"
//     "brick": {
//       "x_cm": n, "y_cm": n, "z_cm": n,                its centre ahead and across, its bottom; default: centred
//                                                       on the body, resting on a frame of beams over the drive
//       "pose": "flat" | "standing",                    lying (screen up) or upright (screen to one end); "flat"
//       "screen": "front" | "back"                      where the screen's top edge (ports A-D) points when
//                                                       flat, or which way the screen faces when standing; "back"
//     },
//     "motors": { "A": PLACE & {"attachment": ATTACHMENT}, ... },
//                                                       a motor that does not drive (any port, either size): where
//                                                       it sits and what it moves; the drive motors sit on the
//                                                       drive's axles
//         ATTACHMENT = "axle" | "arm" | "lift" | "turntable" | "gripper", default "axle":
//           axle       an axle with a short beam on the hub, turning with the motor
//           arm        a long beam from the hub (as long as "length_cm", default 12) that swings with the motor
//           lift       two parallel beams to a fork at their end, swinging with the motor
//           turntable  a turntable on the hub with a beam across it, turning with the motor
//           gripper    two claws on the front of the motor that open as the tacho grows (fully open at
//                      "open_deg", default 90), the way a motor's gripper opens with positive degrees
//     "sensors": { "1": PLACE, ... },                   where each sensor sits
//         PLACE = {"x_cm": n, "y_cm": n, "z_cm": n, "facing": FACING, "yaw_deg": n}
//         FACING = "forward" | "back" | "left" | "right" | "up" | "down": where a sensor's eye, lens, plunger or
//         face points, or a motor's output axle; yaw_deg turns that about the vertical, counter-clockwise from
//         above. A position given in part only fills the rest from the default; no position at all puts the
//         part at a default mount for its kind (colour: down under the front; touch: forward at the front;
//         ultrasonic and infrared: forward where the world's body says the distance sensor reads; gyro: up at
//         the back; medium motor: forward on the front of the brick; large motor: on top of the brick, its axle
//         to the left), moved along a short list of mounts, then upward, until it touches nothing placed.
//     "phone": {                                        a phone standing on the robot, its screen showing a face
//                                                       with two eyes; default: no phone
//       "x_cm": n, "y_cm": n, "bottom_cm": n,           where it stands and how high its lower edge is; default:
//                                                       over the front of the brick, just above it
//       "screen": "front" | "back" | "left" | "right",  which way its screen (the face) looks; default "front"
//       "yaw_deg": n,                                   turned from that about the vertical
//       "orientation": "landscape" | "portrait"         default "landscape"
//     },
//     "bumper": {"x_cm": n},                            a bar of beams and bricks across the body; default none
//     "label": "3"                                      a paper label on the brick's left side (4 characters)
//   }
//
// The physics reads none of this: the distance sensor's rays start at the world's `body.distance_sensor_x_cm`
// and look ahead, and the colour sensor reads the floor at `body.color_sensor_x_cm`, wherever the look puts them.
import { TRACKS } from "./dims";
import type { LookSection, RobotMeta } from "./messages";

export type SensorKind = "touch" | "color" | "ultrasonic" | "gyro" | "ir";
export type Facing = "forward" | "back" | "left" | "right" | "up" | "down";
/** Where a part sits; a null field is left to the default mount. */
export interface Place {
  x: number | null;
  y: number | null;
  z: number | null;
  facing: Facing | null;
  yaw: number;
}
export interface SensorPlace extends Place {
  port: "1" | "2" | "3" | "4";
  kind: SensorKind;
}
export type Attachment = "axle" | "arm" | "lift" | "turntable" | "gripper";
export interface MotorPlace extends Place {
  port: "A" | "B" | "C" | "D";
  size: "large" | "medium";
  attachment: Attachment;
  /** The arm's or the lift's length, cm. */
  length: number;
  /** The gripper's tacho at which it is fully open, degrees. */
  openDeg: number;
}
export interface PhonePlace {
  x: number | null;
  y: number;
  bottom: number | null;
  /** Which way the screen looks, robot frame, degrees counter-clockwise from ahead. */
  yaw: number;
  portrait: boolean;
}
export interface Look {
  drive: "tracks" | "wheels" | "none";
  /** Which tracks: the home set's rubber band on two rims, or the Education set's links on sprockets. */
  track: "rubber" | "links";
  caster: boolean;
  brick: {
    x: number | null;
    y: number;
    z: number | null;
    pose: "flat" | "standing";
    screen: "front" | "back";
    battery: "aa" | "rechargeable";
  };
  phone: PhonePlace | null;
  /** The motors that do not drive, with where the look puts them. */
  motors: MotorPlace[];
  sensors: SensorPlace[];
  bumper: { x: number } | null;
  label: string | null;
}

const FACINGS: readonly Facing[] = ["forward", "back", "left", "right", "up", "down"];
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const n = (v: unknown, fallback: number): number => num(v) ?? fallback;
const oneOf = <T extends string>(v: unknown, of: readonly T[], fallback: T): T =>
  of.includes(v as T) ? (v as T) : fallback;

function place(v: unknown): Place {
  const at = obj(v) ?? {};
  return {
    x: num(at.x_cm),
    y: num(at.y_cm),
    z: num(at.z_cm),
    facing: FACINGS.includes(at.facing as Facing) ? (at.facing as Facing) : null,
    yaw: n(at.yaw_deg, 0),
  };
}

/** The look of a robot: its world's `extensions.view` over defaults. Never throws: a bad field keeps its default. */
export function lookOf(robot: RobotMeta): Look {
  const view: LookSection = robot.world.look;
  const v = view ?? {};
  const brick = obj(v.brick) ?? {};
  const phone = obj(v.phone);
  const bumper = obj(v.bumper);
  const placedSensors = obj(v.sensors) ?? {};
  const placedMotors = obj(v.motors) ?? {};
  const d = robot.drivetrain;
  const drive = d ? oneOf(v.drive, ["tracks", "wheels", "none"] as const, "wheels") : "none";
  const driving = new Set(drive !== "none" && d ? [d.left, d.right] : []);
  const motors: MotorPlace[] = [];
  for (const [port, size] of Object.entries(robot.ports.motors) as [MotorPlace["port"], "large" | "medium"][]) {
    if (driving.has(port)) continue;
    const pm = obj(placedMotors[port]) ?? {};
    motors.push({
      port,
      size,
      ...place(pm),
      attachment: oneOf(pm.attachment, ["axle", "arm", "lift", "turntable", "gripper"] as const, "axle"),
      length: Math.min(40, Math.max(3, n(pm.length_cm, 12))),
      openDeg: Math.max(5, n(pm.open_deg, 90)),
    });
  }
  const sensors: SensorPlace[] = [];
  for (const [port, kind] of Object.entries(robot.ports.sensors) as [SensorPlace["port"], SensorKind][])
    sensors.push({ port, kind, ...place(placedSensors[port]) });
  // the tracks whose rolling diameter is nearest the profile's: 3.68 cm over the rubber band, 5.52 over links
  const nearest =
    d && Math.abs(d.wheel_diameter_cm - TRACKS.rubber.d) <= Math.abs(d.wheel_diameter_cm - TRACKS.links.d)
      ? "rubber"
      : "links";
  return {
    drive,
    track: oneOf(v.track, ["rubber", "links"] as const, nearest),
    caster: drive === "wheels" && v.caster !== "none",
    brick: {
      x: num(brick.x_cm),
      y: n(brick.y_cm, 0),
      z: num(brick.z_cm),
      pose: oneOf(brick.pose, ["flat", "standing"] as const, "flat"),
      screen: oneOf(brick.screen, ["front", "back"] as const, "back"),
      battery: oneOf(brick.battery, ["aa", "rechargeable"] as const, "aa"),
    },
    phone: phone
      ? {
          x: num(phone.x_cm),
          y: n(phone.y_cm, 0),
          bottom: num(phone.bottom_cm),
          yaw:
            { front: 0, left: 90, back: 180, right: -90 }[
              oneOf(phone.screen, ["front", "back", "left", "right"] as const, "front")
            ] + n(phone.yaw_deg, 0),
          portrait: phone.orientation === "portrait",
        }
      : null,
    motors,
    sensors,
    bumper: bumper ? { x: n(bumper.x_cm, -robot.world.body.back_cm + 1) } : null,
    label: typeof v.label === "string" && v.label !== "" ? v.label.slice(0, 4) : null,
  };
}
