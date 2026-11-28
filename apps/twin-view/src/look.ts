// How a twin's body looks in 3D: the look. It is written in the robot file's `twin.view` (CONTRACT §3: the build
// of the robot, so its twin is that robot in any world); apps/local/src/twin-build.ts merges it into the world
// the page receives as `extensions.view`. A robot file without `twin` takes the look from its world's
// `extensions.view`. The parts themselves come from the robot's ports (which motor and which sensor is on each
// port) and its drivetrain (wheel diameter, axle track); the look only says how the person assembled them. Every
// field is optional: a missing or bad field takes its default, and the defaults always give a plausible robot
// whose parts do not overlap and where nothing floats.
//
// Every part is a real LEGO part at its real size (packages/lego-parts, through dims.ts) and sits on the LEGO grid.
// Places: from the centre of the drive axle on the floor, x ahead, y to the left, z up. A place is given in
// modules (`x`, `y`, `z`: 1 module = 8 mm, the pitch of studs and holes; halves allowed, anything finer is rounded
// to a half module), or in centimetres where the person measured it (`x_cm`, `y_cm`, `z_cm`, taken as they are).
// A place is the centre of the part's box, except the brick's z, which is its bottom. A part with no place goes to
// a default mount of its kind on the grid; a part that touches nothing that holds it is held by a beam pinned
// through its own holes to the nearest part below or behind it.
//
//   "view": {
//     "drive": "tracks" | "wheels" | "none"
//         tracks: two tracks; wheels: tyres on rims; none: no drive (a stationary arm, which stands on a base
//         frame of beams on the floor). Default: wheels with a drivetrain, none without.
//     "track": "rubber" | "links"                       the home set's rubber band 53992 on two rims 56145 9.6 cm
//                                                       apart, or the Education set's links 88323 on sprockets
//                                                       57519; default: whichever rolls nearest the profile's
//                                                       wheel diameter (3.68 cm rubber, 5.52 cm links)
//     "wheels_per_side": 1 | 2 | 3                      with wheels: wheels in a row on each side, all turning with
//                                                       that side's motor (geared or chained); default 1
//     "caster": "ball" | "wheel" | "skid" | "none"      what holds up the back with wheels: the steel ball 99948,
//                                                       a small passive wheel (tyre 89201), or a skid sliding on
//                                                       the floor; default "ball" with one wheel per side, "none"
//                                                       with more
//     "shell": "beams" | "panels"                       a frame of beams round the robot, or panels on its sides
//     "brick": {
//       "x" | "x_cm", "y" | "y_cm", "z" | "z_cm",       its centre ahead and across, its bottom; default: centred
//                                                       on the body, on beams pinned into its bottom holes
//       "pose": "flat" | "standing",                    lying (screen up) or upright; default "flat"
//       "screen": "front" | "back",                     where the screen's top edge (ports A-D) points when flat, or
//                                                       which way the screen faces when standing; default "back"
//       "motor_ports": "up" | "down",                   standing: which end the motor ports A-D are at; "up"
//       "battery": "aa" | "rechargeable"                the rechargeable battery makes it 5.08 cm high, AA 4.36
//     },
//     "motors": { "A": PLACE & {"attachment": ATTACHMENT, "on": "B"}, ... },
//                                                       a motor that does not drive (any port, either size): where
//                                                       it sits and what it moves; the drive motors sit on the
//                                                       drive's axles. "on": the port of another motor whose arm or
//                                                       lift carries this one at its end (a claw on a lift): it
//                                                       rides along as that one turns
//         ATTACHMENT = "axle" | "arm" | "lift" | "turntable" | "gripper", default "axle":
//           axle       an axle with a short beam on the hub, turning with the motor
//           arm        a long beam from the hub (as long as "length" modules or "length_cm", default 15
//                      modules) that swings with the motor
//           lift       two parallel beams to a fork at their end, swinging with the motor
//           turntable  a turntable on the hub with a beam across it, turning with the motor
//           gripper    two claws on the front of the motor that open as the tacho grows (fully open at
//                      "open_deg", default 90), the way a motor's gripper opens with positive degrees
//     "sensors": { "1": PLACE, ... },                   where each sensor sits
//         PLACE = {"x" | "x_cm", "y" | "y_cm", "z" | "z_cm", "facing": FACING, "yaw_deg": n}
//         FACING = "forward" | "back" | "left" | "right" | "up" | "down": where a sensor's eye, lens, button or
//         face points (a gyro: its top, the face with the arrows, whose axis it measures), or a motor's output
//         axle; yaw_deg turns that about the vertical, counter-clockwise from above. A place given in part fills
//         the rest from the default. Default mounts: colour down under the front; touch forward at the front;
//         the distance sensor (the lowest port with an ultrasonic or infrared) always with its eye at the body's
//         distance-sensor pose, looking along its heading (sensor-pose.ts: apps/local fills that pose from this
//         place where `body` leaves it out, and refuses a side or a heading the two state differently); another
//         ultrasonic or infrared above it; gyro top up on
//         the brick or the frame; medium motor forward on the front of the brick; large motor on top of the
//         brick, its axle to the left; each moved along a short list of mounts, then upward, until it touches
//         nothing placed.
//     "phone": {                                        a phone standing on the robot, its screen showing a face
//                                                       with two eyes (not a LEGO part: centimetres); default none
//       "x_cm": n, "y_cm": n, "bottom_cm": n,           where it stands and how high its lower edge is; default:
//                                                       over the front of the brick, just above it
//       "screen": "front" | "back" | "left" | "right",  which way its screen (the face) looks; default "front"
//       "yaw_deg": n,                                   turned from that about the vertical
//       "orientation": "landscape" | "portrait"         default "landscape"
//     },
//     "bumper": {"x" | "x_cm": n},                      a bar of beams and bricks across the body; default none
//     "label": "3",                                     a paper label on the brick's left side (4 characters)
//     "unconfirmed": [...]                              reserved, not a bad field: the server copies the build's
//                                                       twin.unconfirmed here (CONTRACT §3) and refuses it written in
//                                                       twin.view; the look reads nothing from it
//   }
//
// What the look cannot show:
//   - The physics reads none of this but the distance sensor's pose (above). The colour sensor reads the floor at
//     `body.color_sensor_x_cm` on the centre line, wherever the look puts it. A distance sensor placed facing up or
//     down is refused when the file is read: the twin reads only level (the page shows what the twin reads,
//     never a direction it does not read).
//   - Only parts of the EV3 sets' electronics, beams, axles, wheels, tracks and casters are drawn; any other
//     LEGO part (gears, panels' shapes, plates with studs, bespoke chassis) is drawn as beams of the same extent.
//   - Gears or a chain between wheels of one side are not drawn: the wheels just turn together.
//   - A cable between a riding motor and the brick is drawn where the motor rests, not following it.
//   - A brick lying on its side (screen to the left or right) and robots of two or more bricks.
//   - Free-form shapes: a sensor tilted at an angle other than a right angle (yaw_deg turns it about the
//     vertical only).
import { MODULE, TRACKS } from "./dims";
import { lenIn, placeIn } from "./place";
import type { LookSection, RobotMeta } from "./messages";

export type SensorKind = "touch" | "color" | "ultrasonic" | "gyro" | "ir";
export type Facing = "forward" | "back" | "left" | "right" | "up" | "down";
/** Where a part sits, cm; a null field is left to the default mount. */
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
export type MotorPort = "A" | "B" | "C" | "D";
export interface MotorPlace extends Place {
  port: MotorPort;
  size: "large" | "medium";
  attachment: Attachment;
  /** The arm's or the lift's length, cm. */
  length: number;
  /** The gripper's tacho at which it is fully open, degrees. */
  openDeg: number;
  /** The motor whose arm or lift carries this one, or null. */
  on: MotorPort | null;
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
  wheelsPerSide: 1 | 2 | 3;
  caster: "ball" | "wheel" | "skid" | "none";
  shell: "beams" | "panels" | null;
  brick: {
    x: number | null;
    y: number;
    z: number | null;
    pose: "flat" | "standing";
    screen: "front" | "back";
    motorPorts: "up" | "down";
    battery: "aa" | "rechargeable";
  };
  phone: PhonePlace | null;
  /** The motors that do not drive, with where the look puts them. */
  motors: MotorPlace[];
  sensors: SensorPlace[];
  bumper: { x: number } | null;
  label: string | null;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const n = (v: unknown, fallback: number): number => num(v) ?? fallback;
const oneOf = <T extends string>(v: unknown, of: readonly T[], fallback: T): T =>
  of.includes(v as T) ? (v as T) : fallback;
/** A length given in modules (rounded to a half module) or in cm, in cm; null when neither is given. */
const len = (at: Record<string, unknown>, k: string): number | null => lenIn(at, k, MODULE);

/** A look's place: x, y, z in modules or cm (null where not given), its facing and yaw_deg (place.ts). */
export const place = (v: unknown): Place => placeIn(v, MODULE);

/** The look of a robot over defaults. Never throws: a bad field keeps its default. */
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
  const ports = Object.keys(robot.ports.motors);
  const motors: MotorPlace[] = [];
  for (const [port, size] of Object.entries(robot.ports.motors) as [MotorPort, "large" | "medium"][]) {
    if (driving.has(port)) continue;
    const pm = obj(placedMotors[port]) ?? {};
    const on = oneOf(pm.on, ["A", "B", "C", "D"] as const, port);
    motors.push({
      port,
      size,
      ...place(pm),
      attachment: oneOf(pm.attachment, ["axle", "arm", "lift", "turntable", "gripper"] as const, "axle"),
      length: Math.min(40, Math.max(3 * MODULE, len(pm, "length") ?? 15 * MODULE)),
      openDeg: Math.max(5, n(pm.open_deg, 90)),
      // a motor rides on another that is there and does not drive, never on itself
      on: on !== port && ports.includes(on) && !driving.has(on) ? on : null,
    });
  }
  // a chain of riders that loops back is no build: the first of the loop stands on its own
  for (const m of motors) {
    const seen = new Set<string>([m.port]);
    for (let c = m.on; c; c = motors.find((x) => x.port === c)?.on ?? null) {
      if (seen.has(c)) {
        m.on = null;
        break;
      }
      seen.add(c);
    }
  }
  const sensors: SensorPlace[] = [];
  for (const [port, kind] of Object.entries(robot.ports.sensors) as [SensorPlace["port"], SensorKind][])
    sensors.push({ port, kind, ...place(placedSensors[port]) });
  // the tracks whose rolling diameter is nearest the profile's: 3.68 cm over the rubber band, 5.52 over links
  const nearest =
    d && Math.abs(d.wheel_diameter_cm - TRACKS.rubber.d) <= Math.abs(d.wheel_diameter_cm - TRACKS.links.d)
      ? "rubber"
      : "links";
  const wps = num(v.wheels_per_side);
  const wheelsPerSide: 1 | 2 | 3 = drive === "wheels" && (wps === 2 || wps === 3) ? wps : 1;
  const brickAt = place(brick);
  return {
    drive,
    track: oneOf(v.track, ["rubber", "links"] as const, nearest),
    wheelsPerSide,
    caster:
      drive === "wheels"
        ? oneOf(v.caster, ["ball", "wheel", "skid", "none"] as const, wheelsPerSide === 1 ? "ball" : "none")
        : "none",
    shell: v.shell === "beams" || v.shell === "panels" ? v.shell : null,
    brick: {
      x: brickAt.x,
      y: brickAt.y ?? 0,
      z: brickAt.z,
      pose: oneOf(brick.pose, ["flat", "standing"] as const, "flat"),
      screen: oneOf(brick.screen, ["front", "back"] as const, "back"),
      motorPorts: oneOf(brick.motor_ports, ["up", "down"] as const, "up"),
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
    bumper: bumper ? { x: len(bumper, "x") ?? -robot.world.body.back_cm + 1 } : null,
    label: typeof v.label === "string" && v.label !== "" ? v.label.slice(0, 4) : null,
  };
}
