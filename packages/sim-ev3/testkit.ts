// Test rig: a SimBrick on a virtual clock, spoken to with real packets.
import type { World } from "../sim-world/world";
import { quietWorld } from "../sim-world/testkit";
import { MOTOR_TAU_MS, SimBrick, VirtualClock, type BrickDrivetrain } from "./brick";
import { frame, decodeReply, type DecodedReply } from "../driver-ev3/encode";

/** The drivetrain the tests hand the brick, as a robot profile would: wheels on B and C, 5.6 cm, 12 cm apart. */
export const DRIVETRAIN: BrickDrivetrain = {
  left: "B",
  right: "C",
  wheel_diameter_cm: 5.6,
  axle_track_cm: 12,
  forward_sign: 1,
};

/** Degrees a motor starting from rest has turned after `ms` at `degS`, behind its first-order lag (MOTOR_TAU_MS). */
export const lagged = (degS: number, ms: number): number => {
  const t = ms / 1000,
    tau = MOTOR_TAU_MS / 1000;
  return degS * (t - tau * (1 - Math.exp(-t / tau)));
};
export function rig(
  world: World = quietWorld(),
  drivetrain: BrickDrivetrain | null = DRIVETRAIN,
): {
  world: World;
  clock: VirtualClock;
  brick: SimBrick;
  call: (bytecodes: number[], globals?: number) => Promise<DecodedReply>;
  run: (ms: number) => void;
} {
  const clock = new VirtualClock();
  const brick = new SimBrick({ world, drivetrain, now: clock.now });
  let counter = 0;
  const call = async (bytecodes: number[], globals = 0): Promise<DecodedReply> => {
    const c = ++counter;
    const reply = decodeReply(await brick.send(frame(bytecodes, { counter: c, globals })));
    if (reply.counter !== c) throw new Error(`reply counter ${reply.counter} != ${c}`);
    return reply;
  };
  return {
    world,
    clock,
    brick,
    call,
    run: (ms) => {
      clock.advance(ms);
      brick.tick();
    },
  };
}
