// One twin, assembled from packages only: a simulated brick in a world, the REAL EV3 provider speaking to it,
// the sim.world provider on the same brick, a runtime over both and its client to the relay.
import { Ev3Provider } from "../../packages/driver-ev3/provider";
import { createRuntime, createRuntimeClient } from "../../packages/runtime";
import type { ClientState, LocalRuntime, RuntimeClient, RuntimeClientOptions } from "../../packages/runtime";
import { LARGE_DEG_S, SimBrick, drivetrainFromProfile } from "../../packages/sim-ev3/brick";
import { World, parseWorld } from "../../packages/sim-world/world";
import { SimWorldProvider } from "../../packages/sim-world/world-provider";
import type { RobotFile } from "./config";

export interface TwinOptions {
  robot_id: string;
  robot: RobotFile;
  /** World file as parsed JSON. */
  world: unknown;
  seed: number;
  server: string;
  token: string;
  onState: (state: ClientState, detail: string) => void;
  onEvent: NonNullable<RuntimeClientOptions["onEvent"]>;
}
export interface Twin {
  robot_id: string;
  brick: SimBrick;
  runtime: LocalRuntime;
  client: RuntimeClient;
}

/** Builds the twin and checks that its devices can be read. Does not connect. */
export async function buildTwin(o: TwinOptions): Promise<Twin> {
  const { pair, hardware } = o.robot;
  // the twin is the same robot under its own id: same drivetrain, roles and limits, so the same profile_hash
  const profile = { ...o.robot.profile, id: o.robot_id };
  const config = parseWorld(o.world);
  const brick = new SimBrick({ world: new World(config, o.seed), drivetrain: drivetrainFromProfile(profile, pair) });
  const runtime = createRuntime({
    profile,
    providers: [
      // first, so the runtime announces backend "sim"
      new SimWorldProvider({ host: brick, worlds: { [config.name]: o.world }, seed: o.seed }),
      (limits) => new Ev3Provider(brick, { limits, hardware, pair, roles: profile.roles, degPerSecAt100: LARGE_DEG_S }),
    ],
  });
  await runtime.ready();
  const client = createRuntimeClient({
    runtime,
    url: o.server,
    token: o.token,
    robot_id: o.robot_id,
    // no reconnect_ms: the runner decides after each close whether to try again (link.ts)
    onState: o.onState,
    onEvent: o.onEvent,
  });
  return { robot_id: o.robot_id, brick, runtime, client };
}
