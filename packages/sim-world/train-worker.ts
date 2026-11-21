// Worker entry point (browser and bun): receives one TrainRequest, streams TrainMessages back.
// Load it only as a Worker; the supervisor in train-supervisor.ts owns its lifetime.
import { runTraining, type TrainMessage, type TrainRequest } from "./train-job";

const scope = globalThis as unknown as {
  onmessage: ((ev: { data: TrainRequest }) => void) | null;
  postMessage(m: TrainMessage): void;
};
scope.onmessage = (ev) => runTraining(ev.data, (m) => scope.postMessage(m));
