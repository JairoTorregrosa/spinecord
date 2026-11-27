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

/**
 * Degrees a motor starting from rest has turned after `ms` under a speed command for `degS`: the firmware's speed
 * loop saturates, so the shaft rises along the full-power lag toward `fullDegS` until it reaches `degS`
 * (at tau ln(full / (full - degS))), and holds `degS` from then on.
 */
export const regulated = (degS: number, ms: number, fullDegS: number, tauMs: number = MOTOR_TAU_MS): number => {
  const t = ms / 1000,
    tau = tauMs / 1000,
    s = Math.sign(degS),
    vp = s * fullDegS,
    at = (u: number) => vp * (u - tau * (1 - Math.exp(-u / tau)));
  const ts = tau * Math.log(fullDegS / (fullDegS - Math.abs(degS)));
  return t <= ts ? at(t) : at(ts) + degS * (t - ts);
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
