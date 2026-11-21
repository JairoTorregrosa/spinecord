// Channel values computed from the world's sensor model. One place for the names, shared by the sim.world
// device and by training, so a condition written against the twin's devices means the same in both.
// Sensor channel names and sign conventions follow contract §2.2 (angles counter-clockwise-positive).
import type { ChannelSpec, Value } from "../protocol/types";
import type { World } from "./world";

export type SimSensorKind = "touch" | "color" | "ultrasonic" | "gyro" | "infrared";
export const SIM_SENSOR_CHANNELS: Record<SimSensorKind, readonly string[]> = {
  touch: ["pressed"],
  color: ["reflected_pct", "color"],
  ultrasonic: ["distance_cm"],
  gyro: ["angle_deg", "rate_deg_s"],
  infrared: ["proximity_pct"],
};

/** One reading of a simulated sensor of `kind`. Fails on a channel the sensor model does not have. */
export function readSensorChannel(world: World, kind: SimSensorKind, channel: string): number | boolean {
  switch (`${kind}.${channel}`) {
    case "touch.pressed":
      return world.senseTouch() === 1;
    case "color.reflected_pct":
      return world.senseReflect();
    case "color.color":
      return world.senseColorId();
    case "ultrasonic.distance_cm":
      return world.senseUltrasonic();
    case "gyro.angle_deg":
      return world.senseGyro();
    case "gyro.rate_deg_s":
      return Math.round(world.rate_deg_s) + 0;
    case "infrared.proximity_pct":
      return world.senseIrProximity();
  }
  const known = SIM_SENSOR_CHANNELS[kind];
  if (!known)
    throw new Error(
      `the simulator has no sensor model for kind "${kind}"; kinds: ${Object.keys(SIM_SENSOR_CHANNELS).join(", ")}`,
    );
  throw new Error(`the simulated ${kind} sensor has no channel "${channel}"; channels: ${known.join(", ")}`);
}

const r2 = (v: number): number => Math.round(v * 100) / 100 + 0;
const headingDeg = (th: number): number => {
  const h = r2((((((th * 180) / Math.PI + 180) % 360) + 360) % 360) - 180);
  return h === -180 ? 180 : h;
};

/** Ground-truth channels of the world itself (everything except the image), as the sim.world device lists them. */
export function worldChannelSpecs(world: World): ChannelSpec[] {
  const c = world.cfg;
  const specs: ChannelSpec[] = [
    {
      name: "pose",
      type: "vector",
      unit: "cm, cm, deg",
      length: 3,
      description:
        "Exact [x_cm, y_cm, heading_deg] of the centre of the wheel axle. heading 0 = +x, counter-clockwise-positive, range -180 (exclusive) to 180.",
    },
    {
      name: "collided",
      type: "boolean",
      description: "true if the robot's last movement was blocked by a wall or obstacle.",
    },
    {
      name: "at_point",
      type: "string",
      description: `Label of the named point whose circle contains the axle centre, or "" when it is in none. Labels: ${c.points.map((p) => p.label).join(", ") || "none in this world"}.`,
    },
    {
      name: "odometer_cm",
      type: "number",
      unit: "cm",
      description:
        "Path length travelled by the axle centre since the last reset or load_world. Turning on the spot adds nothing.",
    },
  ];
  if (c.lines.length > 0) {
    specs.push(
      {
        name: "line_distance_cm",
        type: "number",
        unit: "cm",
        description: "Distance from the axle centre to the centre of the nearest floor line.",
      },
      {
        name: "line_travel_cm",
        type: "number",
        unit: "cm",
        range: [0, 100000],
        description:
          "Net distance covered along the floor line since the last reset or load_world, in either direction (going back subtracts). Counts only while the axle centre is within 12 cm of the line.",
      },
    );
  }
  for (const p of c.points) {
    specs.push(
      {
        name: `distance_to.${p.label}`,
        type: "number",
        unit: "cm",
        description: `Distance from the axle centre to the centre of point ${p.label} (its circle has radius ${p.radius} cm).`,
      },
      {
        name: `bearing_to.${p.label}`,
        type: "number",
        unit: "deg",
        range: [-180, 180],
        description: `Direction of point ${p.label} relative to where the robot faces: 0 = straight ahead, positive = to the left (counter-clockwise).`,
      },
    );
  }
  return specs;
}

/** Value of one world channel (not `frame`). Fails on an unknown channel, listing the known ones. */
export function readWorldChannel(world: World, channel: string): Value {
  const p = world.pose;
  switch (channel) {
    case "pose":
      return [r2(p.x), r2(p.y), headingDeg(p.th)];
    case "collided":
      return world.last_stalled;
    case "at_point":
      return world.cfg.points.find((q) => Math.hypot(q.x - p.x, q.y - p.y) <= q.radius)?.label ?? "";
    case "odometer_cm":
      return r2(world.odometer_cm);
  }
  if (world.cfg.lines.length > 0) {
    if (channel === "line_distance_cm") return r2(world.nearestOnLine(p.x, p.y)!.dist);
    if (channel === "line_travel_cm") return r2(Math.abs(world.line_travel_cm));
  }
  const dot = channel.indexOf(".");
  if (dot > 0) {
    const what = channel.slice(0, dot),
      q = world.cfg.points.find((x) => x.label === channel.slice(dot + 1));
    if (q && what === "distance_to") return r2(Math.hypot(q.x - p.x, q.y - p.y));
    if (q && what === "bearing_to") return headingDeg(Math.atan2(q.y - p.y, q.x - p.x) - p.th);
  }
  throw new Error(
    `world "${world.cfg.name}" has no channel "${channel}"; channels: ${worldChannelSpecs(world)
      .map((s) => s.name)
      .join(", ")}`,
  );
}
