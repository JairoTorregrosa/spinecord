// Viewer page for the simulated EV3: the world live from a SimBrick. The buttons send real EV3 packets
// (the bytes that would go to the brick over USB) and sensors are read with 99 1D.
// Run: `bun run demo` in packages/sim-ev3 (builds dist/ and serves packages/), then open the printed URL.
// Nothing about a robot, a world or a task is compiled in: the example profile, worlds and training specs are
// fetched as files at start, and the page takes any other world or spec as input.
import { World, parseWorld } from "../sim-world/world";
import { mountViewer } from "../sim-world/viewer";
import type { DeviceBindings } from "../sim-world/learn";
import type { SimSensorKind } from "../sim-world/channels";
import type { TrainWorker } from "../sim-world/train-supervisor";
import type { RobotProfile } from "../protocol/types";
import { SimBrick, drivetrainFromProfile } from "./brick";
import type { MotorPort, SensorKindName } from "./ports";
import {
  frame,
  decodeReply,
  readF32,
  toHex,
  outputTimeSync,
  outputStop,
  inputReadySi,
  OUTPUT_MASK,
  ALL_OUTPUTS,
} from "../driver-ev3/encode";

async function load(path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(new URL(path, location.href));
  } catch (e) {
    throw new Error(
      `cannot fetch ${path}: ${(e as Error).message}. Serve packages/sim over http (bun run demo), do not open the file directly.`,
      { cause: e },
    );
  }
  if (!res.ok) throw new Error(`cannot fetch ${path}: HTTP ${res.status}`);
  return res.json();
}
interface TwinConfig {
  pair: { left: MotorPort; right: MotorPort };
  profile: RobotProfile;
}
let twin: TwinConfig, worlds: { name: string }[], specs: { name: string }[];
try {
  twin = (await load("./examples/twin.example.json")) as TwinConfig;
  worlds = (await Promise.all(
    ["line-oval.json", "walls-maze.json"].map((f) => load(`../sim-world/examples/${f}`)),
  )) as {
    name: string;
  }[];
  specs = (await Promise.all(
    ["line-oval.follow-line.training.json", "line-oval.reach-D.training.json"].map((f) =>
      load(`../sim-world/examples/${f}`),
    ),
  )) as { name: string }[];
} catch (e) {
  document.getElementById("status")!.textContent = (e as Error).message;
  throw e;
}

// The twin's geometry comes from the robot profile; the world file only says what is plugged where.
const drivetrain = drivetrainFromProfile(twin.profile, twin.pair);
const brick = new SimBrick({ world: new World(parseWorld(worlds[0]), 1), drivetrain });
const KIND: Record<SensorKindName, SimSensorKind> = {
  touch: "touch",
  color: "color",
  ultrasonic: "ultrasonic",
  gyro: "gyro",
  ir: "infrared",
};
/** Device ids (ev3.S1..S4, sim.world) and the profile's roles, mapped to what they are in the simulator. */
function bindings(): DeviceBindings {
  const out: DeviceBindings = { "sim.world": "sim_world" };
  for (const [port, kind] of Object.entries(brick.ports.sensors)) out[`ev3.S${port}`] = KIND[kind];
  for (const [role, device] of Object.entries(twin.profile.roles)) if (out[device]) out[role] = out[device];
  return out;
}
let counter = 0,
  lastSensors = 0;
const viewer = mountViewer({
  host: brick,
  worlds: Object.fromEntries(worlds.map((w) => [w.name, w])),
  specs: Object.fromEntries(specs.map((s) => [s.name, s])),
  bindings,
  drive: () => (drivetrain ? { axle_track_cm: drivetrain.axle_track_cm } : null),
  createTrainWorker: () =>
    new Worker(new URL("./dist/train-worker.js", location.href), { type: "module" }) as unknown as TrainWorker,
  onFrame: (t) => {
    if (t - lastSensors < 250) return;
    lastSensors = t;
    void showSensors().catch((e) => {
      viewer.el("sensors").textContent = (e as Error).message;
    });
  },
});
const result = viewer.el("result"),
  sensors = viewer.el("sensors");

/** Sends one direct command to the simulated brick and shows the bytes both ways. */
async function send(bytecodes: number[], globals = 0): Promise<Uint8Array> {
  const packet = frame(bytecodes, { counter: (counter = (counter % 0xfffe) + 1), globals });
  const raw = await brick.send(packet);
  const reply = decodeReply(raw);
  result.textContent = `\u2192 ${toHex(packet)}\n\u2190 ${toHex(raw)}${reply.ok ? "" : "\nbrick answered ERROR (0x04): " + brick.errors[brick.errors.length - 1]}`;
  return reply.globals;
}
async function showSensors(): Promise<void> {
  const ports = Object.entries(brick.ports.sensors).sort();
  let text = "";
  if (ports.length) {
    const packet = frame(
      ports.flatMap(([p], i) => inputReadySi(+p - 1, 0, -1, 1, i * 4)),
      { counter: (counter = (counter % 0xfffe) + 1), globals: ports.length * 4 },
    );
    const reply = decodeReply(await brick.send(packet));
    text =
      ports
        .map(([p, kind], i) => `port ${p} ${kind}: ${reply.ok ? readF32(reply.globals, i * 4) : "error"}`)
        .join("\n") + "\n";
  }
  const p = brick.world.pose;
  sensors.textContent =
    text +
    `pose: x ${p.x.toFixed(1)} cm, y ${p.y.toFixed(1)} cm, heading ${(((p.th * 180) / Math.PI) % 360).toFixed(0)}\u00b0` +
    (brick.lcd.length ? `\nLCD: ${brick.lcd.join(" | ")}` : "");
}
/** One time-bounded synced move (B1), the kind of chunk the runtime sends: both wheels for `ms` at `speed`, `turn` -200..200. */
function pairFor(ms: number, speed: number, turn: number): Promise<Uint8Array> {
  if (!drivetrain)
    return Promise.reject(new Error("this robot's profile has no drivetrain: there is no wheel pair to drive"));
  const mask = OUTPUT_MASK[drivetrain.left] | OUTPUT_MASK[drivetrain.right];
  return send(outputTimeSync(mask, speed * drivetrain.forward_sign, turn, ms, true));
}
const act = (fn: () => Promise<unknown>): void => {
  if (viewer.playing) return;
  fn().catch((e) => {
    result.textContent = (e as Error).message;
  });
};
document
  .querySelectorAll<HTMLButtonElement>("[data-drive]")
  .forEach((b) => (b.onclick = () => act(() => pairFor(250, +b.dataset.drive!, 0))));
// Spin in place = turn 200 (one wheel reversed). Which way depends on which wheel is on the lower port.
document.querySelectorAll<HTMLButtonElement>("[data-turn]").forEach(
  (b) =>
    (b.onclick = () =>
      act(() => {
        const left = b.dataset.turn === "left",
          leftIsLower = drivetrain !== null && drivetrain.left < drivetrain.right;
        return pairFor(250, left === leftIsLower ? -30 : 30, 200);
      })),
);
viewer.el("stop").onclick = () => {
  viewer.stopPlaying();
  void send(outputStop(ALL_OUTPUTS, true)).catch((e) => {
    result.textContent = (e as Error).message;
  });
}; // A3: brake all
