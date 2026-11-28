// The terrain worlds of deployments/orugas, driven by a script through the same tools a model calls (no model):
// each is feasible for the orugas robot, and its hard part really fails when it is done wrong.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "../../../packages/runtime/clock";
import { FALL_TILT_DEG, World, parseWorld } from "../../../packages/sim-world/world";
import { slopeDeg } from "../../../packages/sim-world/terrain";
import { REPO, loadConfig } from "../src/config";
import { LocalRobot } from "../src/robot";
import { twinRuntime } from "../src/sources";
import { callTool } from "../src/tools";
import { ROUTES } from "./terrain-routes";

const ORUGAS = join(REPO, "deployments", "orugas", "robots", "orugas.json");
const WORLDS = join(REPO, "deployments", "orugas", "worlds");
const TERRAIN_WORLDS = ["rampa", "puente", "escalones", "colina", "circuito"];
const DEG = 180 / Math.PI;

async function twin(world: string, seed = 1) {
  const clock = new FakeClock();
  const source = loadConfig(["--twin", ORUGAS, "--world", join(WORLDS, `${world}.json`), "--seed", String(seed)])
    .robots[0]! as Parameters<typeof twinRuntime>[0];
  const { runtime, brick } = twinRuntime(source, clock);
  const robot = new LocalRobot({ id: source.id, clock });
  await robot.attach(runtime);
  const tool = async (name: string, args: Record<string, unknown> = {}) =>
    (await callTool([robot], name, { robot_id: source.id, ...args })).envelope as any;
  const read = async (...channels: string[]) => {
    const r = await tool("read_device", { device: "sim.world", channels });
    expect(r.ok).toBe(true);
    return Object.fromEntries(r.data.readings.map((x: { channel: string; value: unknown }) => [x.channel, x.value]));
  };
  /** Turns toward (x, y) and drives there in legs, correcting from sim.world's pose between them, as a person would. */
  const goTo = async (x: number, y: number, o: { tol?: number; leg?: number; speed?: number } = {}) => {
    const tol = o.tol ?? 4,
      leg = o.leg ?? 25;
    for (let i = 0; i < 60; i++) {
      const { pose } = await read("pose");
      const [px, py, h] = pose as number[];
      const dist = Math.hypot(x - px!, y - py!);
      if (dist <= tol) return;
      let bearing = Math.atan2(y - py!, x - px!) * DEG - h!;
      bearing = ((((bearing + 180) % 360) + 360) % 360) - 180;
      if (Math.abs(bearing) > 3) {
        const r = await tool("turn", { angle_deg: Math.round(bearing), speed_pct: 25 });
        expect(r.ok).toBe(true);
        continue;
      }
      const r = await tool("drive", { distance_cm: Math.min(dist, leg), speed_pct: o.speed ?? 40 });
      expect(r.ok).toBe(true);
      if (r.data.reason === "stalled") throw new Error(`stalled on the way to (${x}, ${y}) at (${px}, ${py})`);
    }
    throw new Error(`did not reach (${x}, ${y})`);
  };
  /** Turns until the heading is within 3 deg of `deg` (the tracks scrub: a turn falls short of what it asks). */
  const face = async (deg: number) => {
    for (let i = 0; i < 20; i++) {
      const h = ((await read("pose")).pose as number[])[2]!;
      const d = ((((deg - h + 180) % 360) + 360) % 360) - 180;
      if (Math.abs(d) <= 3) return;
      await tool("turn", { angle_deg: Math.round(d), speed_pct: 25 });
    }
    throw new Error(`could not face ${deg}`);
  };
  return { clock, brick, world: () => brick.world, tool, read, goTo, face };
}

describe("the terrain worlds of deployments/orugas", () => {
  test("every world file parses, its terrain stays within the schema's fields, and the orugas twin starts in it", async () => {
    const schema = JSON.parse(readFileSync(join(REPO, "packages", "sim-world", "world.schema.json"), "utf8"));
    const files = readdirSync(WORLDS).filter((f) => f.endsWith(".json"));
    expect(files).toEqual(expect.arrayContaining(TERRAIN_WORLDS.map((w) => `${w}.json`)));
    for (const f of files) {
      const json = JSON.parse(readFileSync(join(WORLDS, f), "utf8"));
      expect(Object.keys(json).every((k) => k in schema.properties)).toBe(true);
      for (const t of json.terrain ?? []) {
        const def = schema.$defs[t.kind];
        expect(def).toBeDefined();
        expect(def.required.every((k: string) => k in t)).toBe(true);
        expect(Object.keys(t).every((k) => k in def.properties)).toBe(true);
      }
      expect(() => new World(parseWorld(json))).not.toThrow();
    }
    for (const w of TERRAIN_WORLDS) expect((await twin(w)).world().terrain).not.toBeNull();
  });

  test("each route passes every named point and ends in the meta zone, so the drive below proves them all reached", () => {
    for (const name of TERRAIN_WORLDS) {
      const cfg = parseWorld(JSON.parse(readFileSync(join(WORLDS, `${name}.json`), "utf8")));
      const stops = [[cfg.start.x, cfg.start.y], ...ROUTES[name]!];
      for (const p of cfg.points)
        expect(
          stops.some(([x, y]) => Math.hypot(x! - p.x, y! - p.y) + 4 <= p.radius),
          `${name}: point ${p.label}`,
        ).toBe(true);
      for (const z of cfg.zones.filter((z) => z.label))
        expect(
          stops.some(([x, y]) => x! >= z.x && x! <= z.x + z.w && y! >= z.y && y! <= z.y + z.h),
          `${name}: zone ${z.label}`,
        ).toBe(true);
    }
  });

  test("the limits of orugas, and every world's pieces sized away from them", async () => {
    const t = await twin("rampa");
    const d = t.world().terrainDrive();
    // its sprocket's radius, the grip DEFAULT_PUSH_N assumes, the fall's tilt
    expect(d).toEqual({ mass_g: 1000, grip: 0.5, climb_cm: 1.75 });
    const climbDeg = Math.atan(d.grip) * DEG;
    expect(climbDeg).toBeCloseTo(26.57, 2);
    expect(FALL_TILT_DEG).toBe(30);
    const ramps = TERRAIN_WORLDS.flatMap((w) =>
      (JSON.parse(readFileSync(join(WORLDS, `${w}.json`), "utf8")).terrain as any[]).map((p) => ({ world: w, ...p })),
    );
    // the ramps meant to be driven straight are gentle (at most 0.6 of the climb); colina's is the steep one
    for (const r of ramps.filter((p) => p.kind === "ramp" && p.world !== "colina"))
      expect(slopeDeg(r)).toBeLessThanOrEqual(0.6 * climbDeg);
    const hill = ramps.find((p) => p.id === "ladera")!;
    // steeper than the grip straight up (28.5 deg against 26.6), gentler than the fall (30) in every heading
    expect(slopeDeg(hill)).toBeGreaterThan(climbDeg + 1.5);
    expect(slopeDeg(hill)).toBeLessThan(FALL_TILT_DEG - 1);
  });

  for (const name of TERRAIN_WORLDS)
    test(`${name}: the scripted route reaches meta on seeds 1 to 4, never falling`, async () => {
      for (const seed of [1, 2, 3, 4]) {
        const t = await twin(name, seed);
        if (name === "colina") {
          // climb on the diagonal: 55 deg off the fall line, pitch 17 deg (within the grip), roll 24 (within the fall)
          await t.face(35);
          await t.tool("drive", { distance_cm: 95, speed_pct: 40 });
        }
        for (const [x, y] of ROUTES[name]!) await t.goTo(x, y);
        const end = await t.read("at_point", "fallen");
        expect({ seed, ...end } as Record<string, unknown>).toEqual({ seed, at_point: "meta", fallen: "" });
        const kinds: string[] = t
          .world()
          .eventsSince(0)
          .events.map((e) => e.kind);
        expect(kinds).not.toContain("fell");
      }
    }, 60_000);

  test("rampa: off the platform's side it falls, and a reset puts it back on its tracks", async () => {
    const t = await twin("rampa");
    await t.goTo(120, 60);
    await t.face(90);
    const r = await t.tool("drive", { distance_cm: 40, speed_pct: 40 });
    expect(r.data.reason).toBe("stalled");
    expect((await t.read("fallen")).fallen).toMatch(/^fell from plataforma: dropped 12 cm/);
    expect((await t.tool("drive", { distance_cm: -10, speed_pct: 30 })).data.reason).toBe("stalled");
    expect((await t.tool("command_device", { device: "sim.world", command: "reset", args: {} })).ok).toBe(true);
    expect(await t.read("fallen", "tilt")).toEqual({ fallen: "", tilt: [0, 0, 0] });
    // "Restaurar mundo" (sim.world restore): the room from its file, terrain and all, the robot upright at its start
    await t.goTo(120, 60);
    expect(((await t.read("tilt")).tilt as number[])[0]).toBe(12);
    await t.face(90);
    await t.tool("drive", { distance_cm: 40, speed_pct: 40 });
    expect((await t.read("fallen")).fallen).not.toBe("");
    expect((await t.tool("command_device", { device: "sim.world", command: "restore", args: {} })).ok).toBe(true);
    expect(await t.read("fallen", "tilt", "pose")).toEqual({ fallen: "", tilt: [0, 0, 0], pose: [25, 60, 0] });
    expect(t.world().terrain!.pieces.map((p) => p.id)).toEqual(["subida", "plataforma", "bajada"]);
  }, 30_000);

  test("puente: a wrong heading off the narrow bridge falls", async () => {
    const t = await twin("puente");
    await t.goTo(130, 60);
    await t.face(25);
    await t.tool("drive", { distance_cm: 40, speed_pct: 40 });
    expect((await t.read("fallen")).fallen).toMatch(/^fell from puente/);
  }, 30_000);

  test("escalones: straight ahead the high step stalls the drive", async () => {
    const t = await twin("escalones");
    const r = await t.tool("drive", { distance_cm: 100, speed_pct: 40 });
    expect(r.data.reason).toBe("stalled");
    expect((await t.read("blocked_by")).blocked_by).toBe("step escalon_alto 2.5");
    // the low step it rode up onto
    expect(((await t.read("tilt")).tilt as number[])[0]).toBe(1);
  }, 30_000);

  test("colina: straight up the tracks spin and it climbs no higher", async () => {
    const t = await twin("colina");
    await t.face(90);
    const r = await t.tool("drive", { distance_cm: 80, speed_pct: 40 });
    expect(r.ok).toBe(true);
    expect((await t.read("blocked_by")).blocked_by).toMatch(/^steep 26\.\d$/);
    const [, y] = (await t.read("pose")).pose as number[];
    expect(y).toBeLessThan(60);
    expect(
      t
        .world()
        .eventsSince(0)
        .events.map((e) => e.kind),
    ).toContain("too_steep");
    expect((await t.read("fallen")).fallen).toBe("");
  }, 30_000);

  test("circuito: past the curve, straight on, it falls off the meseta", async () => {
    const t = await twin("circuito");
    await t.goTo(112, 47);
    await t.face(0);
    await t.tool("drive", { distance_cm: 45, speed_pct: 40 });
    expect((await t.read("fallen")).fallen).toMatch(/^fell from meseta/);
  }, 30_000);
});
