// Training off the caller's thread: the job runs inside a Worker (CPU isolation: a page stays responsive), and
// this supervisor terminates the Worker when an episode overruns its time budget, so a spec that is far too
// expensive cannot hang the caller.
import type { TrainDone, TrainMessage, TrainRequest } from "./train-job";

/** The part of a Worker the supervisor needs (browser Worker and bun Worker both fit). */
export interface TrainWorker {
  postMessage(message: TrainRequest): void;
  terminate(): void;
  onmessage: ((ev: { data: TrainMessage }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
}
export interface SuperviseOptions {
  /** Creates a fresh worker running train-worker.ts. One worker per training; it is always terminated at the end. */
  createWorker: () => TrainWorker;
  /** Hard wall-clock budget for each episode (and for the final evaluation), ms. Default 2000. */
  episode_budget_ms?: number;
  /** Time allowed for the worker to load and acknowledge the request, ms. Default 10000. */
  startup_budget_ms?: number;
  onProgress?: (episodes_done: number, episodes: number) => void;
}
export class TrainingError extends Error {
  constructor(
    readonly code: "timeout" | "worker_failed" | "training_failed",
    message: string,
  ) {
    super(message);
    this.name = "TrainingError";
  }
}

/**
 * Trains in a Worker. Rejects with TrainingError:
 *  - timeout: an episode did not finish within the budget; the worker was terminated, nothing was learned.
 *  - worker_failed: the worker did not start or crashed.
 *  - training_failed: the job itself failed (invalid spec, a device or channel the twin does not have...).
 */
export function trainInWorker(req: TrainRequest, opts: SuperviseOptions): Promise<TrainDone> {
  const budget = opts.episode_budget_ms ?? 2000,
    startup = opts.startup_budget_ms ?? 10000;
  for (const [name, v] of [
    ["episode_budget_ms", budget],
    ["startup_budget_ms", startup],
  ] as const) {
    if (!(Number.isFinite(v) && v > 0))
      return Promise.reject(new TrainingError("training_failed", `${name} must be a number > 0, got ${v}`));
  }
  return new Promise<TrainDone>((resolve, reject) => {
    let worker: TrainWorker;
    try {
      worker = opts.createWorker();
    } catch (e) {
      reject(new TrainingError("worker_failed", `cannot create the training worker: ${(e as Error).message}`));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false,
      done = 0;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      fn();
    };
    const arm = (ms: number, onTimeout: () => TrainingError): void => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(() => reject(onTimeout())), ms);
    };
    const overrun = (): TrainingError =>
      new TrainingError(
        "timeout",
        done < req.episodes
          ? `training ran out of time: episode ${done + 1} of ${req.episodes} did not finish within ${budget} ms (max_steps too high or a spec that is too expensive for this budget). The training worker was terminated and nothing was learned.`
          : `the evaluation after training did not finish within ${budget} ms. The training worker was terminated.`,
      );
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.t === "started") arm(budget, overrun);
      else if (m.t === "episode") {
        done = m.n;
        arm(budget, overrun);
        opts.onProgress?.(m.n, req.episodes);
      } else if (m.t === "done")
        finish(() => resolve({ result: m.result, random_success_rate: m.random_success_rate, ms: m.ms }));
      else finish(() => reject(new TrainingError("training_failed", m.error)));
    };
    worker.onerror = (ev) =>
      finish(() =>
        reject(
          new TrainingError(
            "worker_failed",
            `the training worker failed: ${ev.message || "it could not be loaded (is the worker bundle built?)"}`,
          ),
        ),
      );
    arm(startup, () => new TrainingError("worker_failed", `the training worker did not start within ${startup} ms`));
    worker.postMessage(req);
  });
}
