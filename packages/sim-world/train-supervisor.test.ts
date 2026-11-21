import { test, expect, describe } from "bun:test";
import { trainInWorker, TrainingError, type TrainWorker } from "./train-supervisor";
import type { TrainRequest } from "./train-job";
import { config, example, DRIVE } from "./testkit";

const LINE = example("line-oval.follow-line.training.json");
const BINDINGS = { color: "color", "sim.world": "sim_world" } as const;
let live: Worker[] = [];
const createWorker = (): TrainWorker => {
  const w = new Worker(new URL("./train-worker.ts", import.meta.url).href);
  live.push(w);
  return w as unknown as TrainWorker;
};
const request = (spec: unknown = LINE, episodes = 40): TrainRequest => {
  const cfg = config();
  return { cfg, pose: cfg.start, drive: DRIVE, spec, bindings: { ...BINDINGS }, episodes, seed: 1 };
};
const failure = async (p: Promise<unknown>): Promise<TrainingError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TrainingError);
    return e as TrainingError;
  }
  throw new Error("did not reject");
};

describe("training in a worker with a hard time budget", () => {
  test("a spec trains off-thread and reports progress", async () => {
    const seen: number[] = [];
    const r = await trainInWorker(request(LINE, 300), { createWorker, onProgress: (n) => seen.push(n) });
    expect(r.result.curve.length).toBe(300);
    expect(r.result.policy.q!.length).toBe(3);
    expect(r.result.policy.spec.name).toBe("line-oval.follow-line");
    expect(r.random_success_rate).toBe(0);
    expect(seen.length).toBe(300);
    expect(seen.at(-1)).toBe(300);
  }, 20000);

  test("a job that overruns its episode budget is cut off: the worker is terminated and the error says why", async () => {
    // Episodes that can only end at max_steps, with a budget far too small for 5000 steps each.
    const endless = {
      ...LINE,
      reward: {
        per_step: 0,
        max_steps: 5000,
        terms: [{ when: { device: "sim.world", channel: "odometer_cm", op: "lt", value: -1 }, reward: 0 }],
      },
    };
    const t0 = performance.now();
    let terminated = 0;
    const e = await failure(
      trainInWorker(request(endless, 100000), {
        episode_budget_ms: 3,
        createWorker: () => {
          const w = createWorker(),
            terminate = w.terminate.bind(w);
          w.terminate = () => {
            terminated++;
            terminate();
          };
          return w;
        },
      }),
    );
    expect(e.code).toBe("timeout");
    expect(e.message).toMatch(/episode \d+ of 100000 did not finish within 3 ms/);
    expect(e.message).toMatch(/terminated and nothing was learned/);
    expect(terminated).toBe(1);
    expect(performance.now() - t0).toBeLessThan(8000); // the caller got control back; it was never blocked
  }, 20000);

  test("spec errors come back as training_failed with the spec's own message", async () => {
    const a = await failure(trainInWorker(request({ ...LINE, schema: "nope" }), { createWorker }));
    expect([a.code, /schema must be/.test(a.message)]).toEqual(["training_failed", true]);
    const b = await failure(trainInWorker({ ...request(), bindings: { "sim.world": "sim_world" } }, { createWorker }));
    expect(b.message).toMatch(/reads device "color", which this twin does not have/);
    expect((await failure(trainInWorker(request("(prev, next) => 1"), { createWorker }))).message).toMatch(
      /root must be an object/,
    );
  }, 20000);

  test("a worker that cannot be created or never answers fails loud", async () => {
    const a = await failure(
      trainInWorker(request(), {
        createWorker: () => {
          throw new Error("no workers here");
        },
      }),
    );
    expect([a.code, a.message]).toEqual(["worker_failed", "cannot create the training worker: no workers here"]);
    let terminated = false;
    const silent: TrainWorker = {
      postMessage() {},
      terminate() {
        terminated = true;
      },
      onmessage: null,
      onerror: null,
    };
    const b = await failure(trainInWorker(request(), { createWorker: () => silent, startup_budget_ms: 50 }));
    expect([b.code, terminated]).toEqual(["worker_failed", true]);
    expect(b.message).toMatch(/did not start within 50 ms/);
    const c = await failure(trainInWorker(request(), { createWorker, episode_budget_ms: 0 }));
    expect(c.message).toMatch(/episode_budget_ms must be a number > 0/);
  });

  test("every worker is terminated when its training ends, whatever the outcome", async () => {
    live = [];
    let terminations = 0;
    const counting = (): TrainWorker => {
      const w = createWorker(),
        t = w.terminate.bind(w);
      w.terminate = () => {
        terminations++;
        t();
      };
      return w;
    };
    await trainInWorker(request(LINE, 5), { createWorker: counting });
    await failure(trainInWorker(request(7), { createWorker: counting }));
    expect([live.length, terminations]).toEqual([2, 2]);
  }, 20000);
});
