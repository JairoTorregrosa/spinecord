// What is plugged into the simulated EV3: the `extensions.ev3` section of a world file.
// It lists devices per port only. Which motors are the drive wheels, and the wheel and axle sizes, are NOT here:
// they come from the robot profile (see BrickDrivetrain in brick.ts).
export type MotorPort = "A" | "B" | "C" | "D";
export type MotorType = "large" | "medium";
export type SensorPort = "1" | "2" | "3" | "4";
export type SensorKindName = "touch" | "color" | "ultrasonic" | "gyro" | "ir";
export interface BrickPorts {
  motors: Partial<Record<MotorPort, MotorType>>;
  sensors: Partial<Record<SensorPort, SensorKindName>>;
}

/** Validates `extensions.ev3` of a world file. Fails naming the exact field. */
export function parseBrickPorts(section: unknown): BrickPorts {
  const fail = (path: string, why: string): never => {
    throw new Error(`world file: extensions.ev3${path} ${why}`);
  };
  const obj = (v: unknown, path: string): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : fail(
          path,
          'must be an object (the simulated brick needs its port map, e.g. {motors: {B: "large", C: "large"}, sensors: {"1": "touch"}})',
        );
  const root = obj(section, "");
  for (const k of Object.keys(root))
    if (k !== "motors" && k !== "sensors") fail(`.${k}`, "is not a known field (motors, sensors)");
  const ports: BrickPorts = { motors: {}, sensors: {} };
  for (const [port, type] of Object.entries(root.motors === undefined ? {} : obj(root.motors, ".motors"))) {
    if (!["A", "B", "C", "D"].includes(port)) fail(`.motors.${port}`, "is not a motor port (A, B, C, D)");
    if (type === "left" || type === "right")
      fail(
        `.motors.${port}`,
        `must be the motor type, large or medium: which motors drive the wheels comes from the robot profile, not from the world file`,
      );
    if (type !== "large" && type !== "medium")
      fail(`.motors.${port}`, `must be large or medium, got ${JSON.stringify(type)}`);
    ports.motors[port as MotorPort] = type as MotorType;
  }
  for (const [port, kind] of Object.entries(root.sensors === undefined ? {} : obj(root.sensors, ".sensors"))) {
    if (!["1", "2", "3", "4"].includes(port)) fail(`.sensors.${port}`, "is not a sensor port (1, 2, 3, 4)");
    if (kind !== "touch" && kind !== "color" && kind !== "ultrasonic" && kind !== "gyro" && kind !== "ir")
      fail(`.sensors.${port}`, `must be touch, color, ultrasonic, gyro or ir, got ${JSON.stringify(kind)}`);
    ports.sensors[port as SensorPort] = kind as SensorKindName;
  }
  return ports;
}
