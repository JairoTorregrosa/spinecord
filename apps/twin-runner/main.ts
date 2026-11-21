// Headless twin runner: builds one twin per --robot-id and keeps each connected to a spinecord relay.
// A thin shell: everything a twin does lives in packages/ (twin.ts wires them). Runs on macOS, Windows and Linux.
//   bun apps/twin-runner/main.ts --server ws://127.0.0.1:8787/ws/robot --token-file <path> \
//     --profile deployments/example/robots/r1.json --world packages/sim-world/examples/line-oval.json
// Prints one JSON line per event ({"ev":"twin","robot_id","state","detail"}). Exits 1 when an input is wrong or
// the relay refuses a twin (unknown robot id, bad token, rejected profile, another runtime took the id); an
// unreachable relay, a 5xx and a lost connection are retried with backoff (link.ts).
import { loadConfig, USAGE, type RunnerConfig } from "./config";
import { backoffMs, judgeClose } from "./link";
import { buildTwin, type Twin } from "./twin";
import { serveView, type ViewServer } from "./view";

const log = (ev: string, fields: Record<string, unknown>): void => console.log(JSON.stringify({ ev, ...fields }));

let config: RunnerConfig;
try {
  config = loadConfig(process.argv.slice(2));
} catch (e) {
  console.error(`twin-runner: ${(e as Error).message}\n\n${USAGE}`);
  process.exit(2);
}

const twins: Twin[] = [];
let view: ViewServer | null = null;
let ending = false;
function end(code: number, why: string): void {
  if (ending) return;
  ending = true;
  log("exit", { code, why });
  view?.stop();
  for (const t of twins) {
    t.client.close();
    t.runtime.dispose();
  }
  // let the sockets say goodbye; nothing else keeps the process
  setTimeout(() => process.exit(code), 100);
}
/** A twin's socket closed: exit when the relay will never accept it (link.ts), else reconnect with backoff. */
const attempts = new Map<string, number>();
async function closed(robot_id: string, detail: string): Promise<void> {
  const verdict = await judgeClose(detail, config.server, robot_id);
  if (ending) return;
  if (!verdict.retry) return end(1, `${robot_id}: ${verdict.why}`);
  const attempt = attempts.get(robot_id) ?? 0;
  attempts.set(robot_id, attempt + 1);
  const wait_ms = backoffMs(attempt);
  log("retry", { robot_id, attempt: attempt + 1, wait_ms, why: verdict.why });
  setTimeout(() => {
    if (!ending) twins.find((t) => t.robot_id === robot_id)?.client.connect();
  }, wait_ms);
}

try {
  for (const robot_id of config.robotIds) {
    twins.push(
      await buildTwin({
        robot_id,
        robot: config.robot,
        world: config.world,
        seed: config.seed,
        server: config.server,
        token: config.token,
        onState: (state, detail) => {
          if (ending) return;
          log("twin", { robot_id, state, detail });
          if (state === "online") attempts.delete(robot_id);
          if (state === "closed") void closed(robot_id, detail);
        },
        onEvent: (e) => log("twin_event", { robot_id, ...e }),
      }),
    );
  }
  if (config.view) {
    view = await serveView(twins, { name: config.worldName, json: config.world }, config.view.port);
    log("view", { url: view.url, twins: twins.map((t) => t.robot_id) });
  }
} catch (e) {
  console.error(`twin-runner: ${(e as Error).message}`);
  process.exit(1);
}

process.on("SIGINT", () => end(0, "SIGINT"));
process.on("SIGTERM", () => end(0, "SIGTERM"));
for (const t of twins) t.client.connect();
