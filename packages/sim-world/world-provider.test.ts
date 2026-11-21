import { test, expect, describe } from "bun:test";
import { inflateSync } from "node:zlib";
import { RuntimeError } from "../protocol/types";
import { SimWorldProvider, type WorldHost } from "./world-provider";
import { World } from "./world";
import { quietWorld, EXAMPLES } from "./testkit";

/** The smallest host: a world that nothing drives. */
class StillHost implements WorldHost {
  ticks = 0;
  constructor(
    public world: World,
    private readonly accept: (w: World) => void = () => {},
  ) {}
  tick(): void {
    this.ticks++;
  }
  setWorld(world: World): void {
    this.accept(world);
    this.world = world;
  }
}
const make = (host: WorldHost = new StillHost(quietWorld())) =>
  new SimWorldProvider({
    host,
    worlds: { "line-oval": EXAMPLES.lineOval, "walls-maze": EXAMPLES.wallsMaze },
    now: () => 1234,
  });
const idle = new AbortController().signal;
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RuntimeError);
    return (e as RuntimeError).code;
  }
  throw new Error("did not throw");
};
const pngSize = (b64: string): [number, number] => {
  const png = Buffer.from(b64, "base64"),
    dv = new DataView(png.buffer, png.byteOffset);
  expect([...png.subarray(0, 4)]).toEqual([137, 80, 78, 71]);
  inflateSync(png.subarray(41, 41 + dv.getUint32(33)));
  return [dv.getUint32(16), dv.getUint32(20)];
};

describe("SimWorldProvider", () => {
  test("announces sim.world and sim.camera with bounded commands and described channels", async () => {
    const p = make();
    expect([p.id, p.backend]).toEqual(["sim", "sim"]);
    const devs = await p.devices();
    expect(devs.map((d) => [d.id, d.kind, d.provider])).toEqual([
      ["sim.world", "sim_world", "sim"],
      ["sim.camera", "camera", "sim"],
    ]);
    const world = devs[0]!;
    expect(world.channels.map((c) => [c.name, c.type])).toEqual([
      ["pose", "vector"],
      ["collided", "boolean"],
      ["at_point", "string"],
      ["odometer_cm", "number"],
      ["line_distance_cm", "number"],
      ["line_travel_cm", "number"],
      ...["A", "B", "C", "D"].flatMap((l) => [
        [`distance_to.${l}`, "number"],
        [`bearing_to.${l}`, "number"],
      ]),
      ["frame", "image"],
    ]);
    expect(p.stop_worst_ms).toBeGreaterThan(0);
    expect(world.commands.map((c) => [c.name, c.bound.kind])).toEqual([
      ["load_world", "instant"],
      ["reset", "instant"],
    ]);
    expect(world.commands[0]!.description).toContain("line-oval, walls-maze");
    expect(world.description).toContain("A (15, 75)");
    for (const d of devs)
      for (const c of [...d.channels, ...d.commands]) expect(c.description.length).toBeGreaterThan(20);
    expect(devs[1]!.channels.map((c) => c.name)).toEqual(["frame"]);
  });
  test("pose is exact [x_cm, y_cm, heading_deg], and the host's physics is brought up to date first", async () => {
    const host = new StillHost(quietWorld());
    const p = make(host);
    expect(await p.read("sim.world", ["pose"])).toEqual([
      { device: "sim.world", channel: "pose", value: [43, 25, 0], unit: "cm, cm, deg", ts: 1234 },
    ]);
    expect(host.ticks).toBe(1);
    // Omitting the channels gives every non-image channel, and never the picture.
    const all = await p.read("sim.world");
    expect(all.map((r) => r.channel)).not.toContain("frame");
    expect(all.length).toBe(14);
    expect(all.every((r) => r.value !== null && r.image === undefined)).toBe(true);
    host.world.advance(-(Math.PI * 6) * 0.75, Math.PI * 6 * 0.75, 10); // 135 deg left
    host.world.advance(10, 10, 10);
    const [x, y, h] = (await p.read("sim.world", ["pose"]))[0]!.value as number[];
    expect(h).toBeCloseTo(135, 1);
    expect(x).toBeCloseTo(43 - 10 * Math.SQRT1_2, 1);
    expect(y).toBeCloseTo(25 + 10 * Math.SQRT1_2, 1);
  });
  test("ground-truth channels a condition can use: named points, collision, line and trip meters", async () => {
    const host = new StillHost(quietWorld());
    const p = make(host);
    const get = async (channel: string) => (await p.read("sim.world", [channel]))[0]!.value;
    expect(await get("at_point")).toBe("");
    expect(await get("collided")).toBe(false);
    expect(await get("distance_to.D")).toBeCloseTo(Math.hypot(28, 10), 1);
    expect(await get("bearing_to.D")).toBeCloseTo(-160.35, 1); // behind and to the right of a robot facing +x
    expect(await get("bearing_to.B")).toBeCloseTo(38.88, 1); // ahead and to the left
    expect(await get("line_distance_cm")).toBeLessThan(0.5);
    host.world.advance(15, 15, 20);
    expect(await get("odometer_cm")).toBe(15);
    expect(await get("line_travel_cm")).toBeCloseTo(15, 1);
    host.world.setPose({ x: 18, y: 18, th: 0 });
    expect(await get("at_point")).toBe("D");
    expect(await get("odometer_cm")).toBe(0);
    host.world.setPose({ x: 100, y: 45, th: 0 });
    host.world.advance(40, 40, 20);
    expect(await get("collided")).toBe(true);
    // A world without lines does not offer the line channels at all.
    const bare = new StillHost(quietWorld(EXAMPLES.lineOval, { lines: [] }));
    expect((await make(bare).devices())[0]!.channels.map((c) => c.name)).not.toContain("line_travel_cm");
    expect(await code(make(bare).read("sim.world", ["line_travel_cm"]))).toBe("unknown_channel");
  });
  test("frames come as Reading.image (PNG): overhead at world size, first-person at 160x120; omitted channels skip images", async () => {
    const p = make();
    const [frame] = await p.read("sim.world", ["frame"]);
    expect(frame!.value).toBeNull(); // contract: never a string in value
    expect([frame!.image!.mime, frame!.image!.age_ms, frame!.ts]).toEqual(["image/png", 0, 1234]);
    expect(pngSize(frame!.image!.b64)).toEqual([480, 360]);
    const [cam] = await p.read("sim.camera", ["frame"]);
    expect(cam!.value).toBeNull();
    expect(pngSize(cam!.image!.b64)).toEqual([160, 120]);
    expect(await p.read("sim.camera")).toEqual([]);
  });
  test("reset teleports and re-zeroes; defaults to the world's start pose", async () => {
    const host = new StillHost(quietWorld());
    const p = make(host);
    const r = await p.command("sim.world", "reset", { x_cm: 80, y_cm: 70, heading_deg: -90 }, idle);
    expect(r).toEqual({
      requested: { x_cm: 80, y_cm: 70, heading_deg: -90 },
      measured: { world: "line-oval", pose: [80, 70, -90] },
      clamped: false,
      reason: "completed",
      ms: 0,
    });
    expect(host.world.senseGyro()).toBe(0);
    expect((await p.command("sim.world", "reset", {}, idle)).measured.pose).toEqual([43, 25, 0]);
    expect((await p.command("sim.world", "reset", { heading_deg: 180 }, idle)).measured.pose).toEqual([43, 25, 180]);
  });
  test("reset into a wall or with junk is invalid_argument and moves nothing", async () => {
    const host = new StillHost(quietWorld());
    const p = make(host);
    expect(await code(p.command("sim.world", "reset", { x_cm: 2, y_cm: 2 }, idle))).toBe("invalid_argument");
    expect(await code(p.command("sim.world", "reset", { x_cm: 60, y_cm: 45 }, idle))).toBe("invalid_argument"); // inside the obstacle
    expect(await code(p.command("sim.world", "reset", { x_cm: "left" }, idle))).toBe("invalid_argument");
    expect(await code(p.command("sim.world", "reset", { x: 10 }, idle))).toBe("invalid_argument");
    expect(host.world.pose).toEqual({ x: 43, y: 25, th: 0 });
  });
  test("load_world by name, or from a whole world file given as JSON text", async () => {
    const host = new StillHost(quietWorld());
    const p = make(host);
    const r = await p.command("sim.world", "load_world", { world: "walls-maze" }, idle);
    expect(r.measured).toEqual({ world: "walls-maze", pose: [15, 15, 90] });
    expect(host.world.cfg.width).toBe(150);
    const custom = { ...EXAMPLES.lineOval, name: "mine", start: { x: 60, y: 15, heading_deg: 180 } };
    expect((await p.command("sim.world", "load_world", { world: JSON.stringify(custom) }, idle)).measured).toEqual({
      world: "mine",
      pose: [60, 15, 180],
    });
    expect((await p.devices())[0]!.description).toContain('"mine"');
  });
  test("load_world failures are invalid_argument with the reason, and keep the current world", async () => {
    const host = new StillHost(quietWorld(), (w) => {
      if (w.cfg.name === "walls-maze") throw new Error("this body cannot live there");
    });
    const p = make(host);
    expect(await code(p.command("sim.world", "load_world", { world: "nowhere" }, idle))).toBe("invalid_argument");
    expect(await code(p.command("sim.world", "load_world", { world: "{not json" }, idle))).toBe("invalid_argument");
    expect(
      await code(
        p.command("sim.world", "load_world", { world: JSON.stringify({ ...EXAMPLES.lineOval, arena: {} }) }, idle),
      ),
    ).toBe("invalid_argument");
    expect(await code(p.command("sim.world", "load_world", {}, idle))).toBe("invalid_argument");
    await expect(p.command("sim.world", "load_world", { world: "walls-maze" }, idle)).rejects.toThrow(
      /cannot live there/,
    );
    await expect(p.command("sim.world", "load_world", { world: "nowhere" }, idle)).rejects.toThrow(
      /line-oval, walls-maze/,
    );
    expect(host.world.cfg.name).toBe("line-oval");
  });
  test("onDevicesChanged fires once per successful load_world, never on reset or a failed load, and unsubscribes", async () => {
    const p = make();
    let fired = 0;
    const off = p.onDevicesChanged(() => {
      fired++;
    });
    await p.command("sim.world", "reset", { x_cm: 80, y_cm: 70 }, idle);
    expect(fired).toBe(0);
    await p.command("sim.world", "load_world", { world: "walls-maze" }, idle);
    expect(fired).toBe(1);
    expect(await code(p.command("sim.world", "load_world", { world: "nowhere" }, idle))).toBe("invalid_argument");
    expect(fired).toBe(1);
    off();
    await p.command("sim.world", "load_world", { world: "line-oval" }, idle);
    expect(fired).toBe(1);
  });
  test("unknown device, channel and command are typed errors", async () => {
    const p = make();
    expect(await code(p.read("sim.lidar"))).toBe("unknown_device");
    expect(await code(p.read("sim.world", ["speed"]))).toBe("unknown_channel");
    expect(await code(p.command("sim.world", "explode", {}, idle))).toBe("unknown_command");
    expect(await code(p.command("sim.camera", "zoom", {}, idle))).toBe("unknown_command");
    expect(await code(p.command("sim.arm", "reset", {}, idle))).toBe("unknown_device");
  });
  test("an aborted signal resolves preempted without acting; stop has nothing to brake", async () => {
    const host = new StillHost(quietWorld());
    const p = make(host);
    const ac = new AbortController();
    ac.abort();
    const r = await p.command("sim.world", "reset", { x_cm: 80, y_cm: 70 }, ac.signal);
    expect(r.reason).toBe("preempted");
    expect(host.world.pose.x).toBe(43);
    expect(await p.stop()).toEqual({ motors_stopped: true });
  });
});
