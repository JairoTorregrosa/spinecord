// Browser side of --view. The twin lives in the runner process; this page mirrors it: a World built from the
// same world file whose pose is copied from the runner a few times per second, drawn by the sim-world viewer
// (mountViewer). No physics and no drawing code here. Pick a twin with ?robot=<id> (default: the first one).
import { mountViewer } from "../../packages/sim-world/viewer";
import { World, parseWorld, type Pose } from "../../packages/sim-world/world";
import type { WorldHost } from "../../packages/sim-world/world-provider";

interface TwinState {
  robot_id: string;
  link: string;
  world: string;
  pose: Pose;
}
const POLL_MS = 100;
const label = document.getElementById("twin")!;
const say = (text: string, error = false): void => {
  label.textContent = text;
  label.className = error ? "err" : "";
};
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

try {
  const twins = await get<string[]>("/twins");
  const robot = new URLSearchParams(location.search).get("robot") ?? twins[0];
  if (robot === undefined || !twins.includes(robot))
    throw new Error(`no twin "${robot}" in this runner; twins: ${twins.join(", ") || "none"}`);
  const world = await get<{ name: string; json: unknown }>("/world");

  // The mirror: it never runs physics (tick does nothing); the viewer puts its own World in it at start.
  const host: WorldHost = {
    world: new World(parseWorld(world.json), 1),
    tick() {},
    setWorld(next: World) {
      (host as { world: World }).world = next;
    },
  };
  mountViewer({
    host,
    worlds: { [world.name]: world.json },
    specs: {},
    bindings: () => ({}),
    drive: () => null,
    createTrainWorker: () => {
      throw new Error("training is not part of the twin view: use the sim-ev3 demo page");
    },
  });

  const poll = async (): Promise<void> => {
    try {
      const s = await get<TwinState>(`/state?robot=${encodeURIComponent(robot)}`);
      if (s.world !== world.name) {
        say(
          `${s.robot_id} is now in world "${s.world}"; this view has "${world.name}" (the one the runner started with)`,
          true,
        );
      } else {
        host.world.pose = s.pose;
        say(
          `${s.robot_id} · link ${s.link} · world ${s.world} · x ${s.pose.x.toFixed(1)} cm, y ${s.pose.y.toFixed(1)} cm, heading ${(((s.pose.th * 180) / Math.PI) % 360).toFixed(0)}°`,
        );
      }
    } catch (e) {
      say(`runner not reachable: ${(e as Error).message}`, true);
    }
    setTimeout(() => void poll(), POLL_MS);
  };
  void poll();
} catch (e) {
  say((e as Error).message, true);
  throw e;
}
