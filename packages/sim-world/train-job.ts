// One training job and the messages a training worker sends while it runs it.
import { World, type WorldConfig, type Pose, type DriveGeometry } from "./world";
import { train, evaluate, randomPolicy, parseTrainingSpec, type DeviceBindings, type TrainResult } from "./learn";

export interface TrainRequest {
  cfg: WorldConfig;
  pose: Pose;
  /** Drivetrain geometry of the twin's body, from the robot profile. */
  drive: DriveGeometry;
  /** The training spec as parsed JSON (schema spinecord/training@1); it is validated inside the job. */
  spec: unknown;
  /** Device id or role -> what it is in the twin (see DeviceBindings). */
  bindings: DeviceBindings;
  episodes: number;
  seed: number;
}
export interface TrainDone {
  result: TrainResult;
  random_success_rate: number;
  ms: number;
}
export type TrainMessage =
  | { t: "started" }
  | { t: "episode"; n: number } // heartbeat: episode n of the request finished
  | ({ t: "done" } & TrainDone)
  | { t: "error"; error: string };

/** Runs the job in the calling thread, reporting through `post`. Never throws: failures are an "error" message. */
export function runTraining(req: TrainRequest, post: (m: TrainMessage) => void): void {
  post({ t: "started" });
  try {
    const t0 = performance.now();
    const spec = parseTrainingSpec(req.spec);
    const world = new World({ ...req.cfg, start: req.pose }, req.seed, req.drive);
    const result = train(world, spec, req.bindings, req.episodes, req.seed, {
      on_episode: (n) => post({ t: "episode", n }),
    });
    const random_success_rate = evaluate(randomPolicy(spec), world, req.bindings, 50).success_rate;
    post({ t: "done", result, random_success_rate, ms: performance.now() - t0 });
  } catch (e) {
    post({ t: "error", error: (e as Error).message });
  }
}
