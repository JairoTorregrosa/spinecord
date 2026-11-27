// How a twin's body looks in 3D: the optional `extensions.view` section of its world file, with defaults that
// fit any EV3 base. Only the look: the physics keeps using the world's `body` and the profile's drivetrain.
//
//   "view": {
//     "drive": "tracks" | "wheels",                    default "wheels"
//     "brick": {"x_cm": n, "screen": "front" | "back"}, where the brick sits; which end its screen points to
//     "phone": {"x_cm": n, "bottom_cm": n, "screen": "front" | "back"},  a phone standing across the body
//     "sensors": {"4": {"x_cm": n, "y_cm": n, "z_cm": n}},  where a sensor sits (y to the left, z up)
//     "bumper": {"x_cm": n},                            a bar across the body
//     "label": "3"                                      a paper label stuck on the left motor
//   }
// Every length is in cm from the centre of the wheel axle on the floor: x ahead, y to the left, z up.
import type { LookSection, RobotMeta } from "./messages";

export type SensorKind = "touch" | "color" | "ultrasonic" | "gyro" | "ir";
export interface SensorPlace {
  port: "1" | "2" | "3" | "4";
  kind: SensorKind;
  x: number;
  y: number;
  z: number;
  /** Where its eye or plunger points. */
  facing: "forward" | "down" | "up";
}
export interface Look {
  drive: "tracks" | "wheels";
  brick: { x: number; screen: "front" | "back" };
  phone: { x: number; bottom: number; screen: "front" | "back" } | null;
  sensors: SensorPlace[];
  bumper: { x: number } | null;
  label: string | null;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const n = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** The look of a robot: its world's `extensions.view` over defaults. Never throws: a bad field keeps its default. */
export function lookOf(robot: RobotMeta): Look {
  const view: LookSection = robot.world.look;
  const v = view ?? {};
  const b = robot.world.body;
  const brick = obj(v.brick) ?? {};
  const phone = obj(v.phone);
  const bumper = obj(v.bumper);
  const placed = obj(v.sensors) ?? {};
  const sensors: SensorPlace[] = [];
  for (const [port, kind] of Object.entries(robot.ports.sensors) as [SensorPlace["port"], SensorKind][]) {
    const at = obj(placed[port]) ?? {};
    const def: Omit<SensorPlace, "port" | "kind"> =
      kind === "color"
        ? { x: b.color_sensor_x_cm, y: 0, z: 1.6, facing: "down" }
        : kind === "touch"
          ? { x: b.front_cm - 1.4, y: 0, z: 3.2, facing: "forward" }
          : kind === "gyro"
            ? { x: -b.back_cm + 3, y: b.half_width_cm - 2.5, z: 10.6, facing: "up" }
            : { x: b.distance_sensor_x_cm - 1.2, y: 0, z: 6.5, facing: "forward" };
    sensors.push({
      port,
      kind,
      x: n(at.x_cm, def.x),
      y: n(at.y_cm, def.y),
      z: n(at.z_cm, def.z),
      facing: def.facing,
    });
  }
  return {
    drive: v.drive === "tracks" ? "tracks" : "wheels",
    brick: { x: n(brick.x_cm, (b.front_cm - b.back_cm) / 2 - 1), screen: brick.screen === "front" ? "front" : "back" },
    phone: phone
      ? { x: n(phone.x_cm, 0), bottom: n(phone.bottom_cm, 10), screen: phone.screen === "back" ? "back" : "front" }
      : null,
    sensors,
    bumper: bumper ? { x: n(bumper.x_cm, -b.back_cm + 1) } : null,
    label: typeof v.label === "string" && v.label !== "" ? v.label.slice(0, 4) : null,
  };
}
