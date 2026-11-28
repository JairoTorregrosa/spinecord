// Every world of every deployment is one its robots can do: it parses, it says what the person does there
// (`description`), each robot with a `twin` fits at its start, and from there it reaches every labelled zone and named
// point turning on the spot wherever it goes. The proof is a breadth-first search on a 1 cm grid of the places the
// axle centre can be, with every wall and box grown by the radius the footprint sweeps as it spins (the farthest
// corner from the axle). It is conservative: a passage narrower than twice that radius (about 18 to 32 cm for a
// robot 18 cm wide) fails here although the robot could drive straight through it, so a map that passes has room to
// turn everywhere. Pushable boxes count as fixed: a path that needs a push is not a path. The world files of a folder
// are also the names `use_map` takes, so each file is named after the world inside it.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { World, parseWorld, type Rect, type WorldConfig } from "../../../packages/sim-world/world";
import { MAX_SIBLING_WORLD_BYTES, REPO, loadConfig, mapNameMismatches } from "../src/config";
import { LocalRobot } from "../src/robot";
import { twinRuntime } from "../src/sources";
import { callTool } from "../src/tools";
import { ROUTES } from "./terrain-routes";

const DEPLOYMENTS = join(REPO, "deployments");
const jsonIn = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => join(dir, f))
    : [];
const deployments = readdirSync(DEPLOYMENTS)
  .map((d) => ({
    name: d,
    worlds: jsonIn(join(DEPLOYMENTS, d, "worlds")),
    // only robots with a build run as a twin in any world
    robots: jsonIn(join(DEPLOYMENTS, d, "robots")).filter((f) => {
      const raw = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
      return typeof raw.twin === "object" && raw.twin !== null;
    }),
  }))
  .filter((d) => d.worlds.length > 0 && d.robots.length > 0);

/** Distance from point (x, y) to rectangle r (0 inside it). */
const distTo = (x: number, y: number, r: Rect): number =>
  Math.hypot(Math.max(r.x - x, 0, x - (r.x + r.w)), Math.max(r.y - y, 0, y - (r.y + r.h)));
const inRect = (x: number, y: number, r: Rect): boolean => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** The cells (cm, centres at +0.5) the axle centre reaches from the start with a body of spin radius `radius`. */
function reachable(cfg: WorldConfig, radius: number): { free: (x: number, y: number) => boolean; seen: Uint8Array } {
  const W = Math.floor(cfg.width),
    H = Math.floor(cfg.height);
  const ok = new Uint8Array(W * H);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const x = i + 0.5,
        y = j + 0.5;
      const walls = x >= radius && y >= radius && x <= cfg.width - radius && y <= cfg.height - radius;
      ok[j * W + i] = walls && cfg.boxes.every((b) => distTo(x, y, b) >= radius) ? 1 : 0;
    }
  const seen = new Uint8Array(W * H);
  const si = Math.floor(cfg.start.x),
    sj = Math.floor(cfg.start.y);
  const queue: number[] = [];
  if (ok[sj * W + si]) {
    seen[sj * W + si] = 1;
    queue.push(sj * W + si);
  }
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q]!;
    const i = c % W,
      j = (c - i) / W;
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const ni = i + di,
        nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const n = nj * W + ni;
      if (ok[n] && !seen[n]) {
        seen[n] = 1;
        queue.push(n);
      }
    }
  }
  return { free: (x, y) => ok[Math.floor(y) * W + Math.floor(x)] === 1, seen };
}

/** Whether a reachable cell has its centre where `inside` says. */
function reaches(cfg: WorldConfig, seen: Uint8Array, inside: (x: number, y: number) => boolean): boolean {
  const W = Math.floor(cfg.width);
  for (let c = 0; c < seen.length; c++) if (seen[c] && inside((c % W) + 0.5, Math.floor(c / W) + 0.5)) return true;
  return false;
}

test("there is at least one deployment with worlds and a robot that has a twin", () => {
  expect(deployments.length).toBeGreaterThan(0);
});

for (const d of deployments)
  describe(`deployments/${d.name}`, () => {
    test("each world file is named after the world inside it, and those are the names use_map takes", () => {
      const names = d.worlds.map((f) => parseWorld(JSON.parse(readFileSync(f, "utf8"))).name);
      expect(names).toEqual(d.worlds.map((f) => basename(f, ".json")));
      const twin = loadConfig(["--twin", d.robots[0]!, "--world", d.worlds[0]!]).robots[0]!;
      if (twin.source !== "twin") throw new Error("not a twin");
      expect(Object.keys(twin.worlds ?? {}).sort()).toEqual([...names].sort());
    });

    for (const file of d.worlds)
      describe(basename(file), () => {
        test("it says what the person does there, and its boxes lie inside the arena without overlapping", () => {
          const cfg = parseWorld(JSON.parse(readFileSync(file, "utf8")));
          expect(cfg.description?.length ?? 0).toBeGreaterThan(20);
          for (const b of cfg.boxes) {
            expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= cfg.width && b.y + b.h <= cfg.height).toBe(true);
            for (const o of cfg.boxes)
              if (o !== b)
                expect(
                  b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h,
                  `${b.id} ${o.id}`,
                ).toBe(false);
          }
        });

        for (const robot of d.robots)
          test(`${basename(robot)} fits at the start, in a labelled zone, and reaches every other zone and point`, () => {
            const twin = loadConfig(["--twin", robot, "--world", file]).robots[0]!;
            if (twin.source !== "twin") throw new Error("not a twin");
            const cfg = parseWorld(twin.world);
            new World(cfg, 1); // throws when the footprint overlaps a wall or a box at the start
            const base = cfg.zones.filter((z) => z.label && inRect(cfg.start.x, cfg.start.y, z));
            expect(base.length, "the start lies in a labelled zone").toBeGreaterThan(0);
            const b = cfg.body;
            const spin = Math.hypot(Math.max(b.front_cm, b.back_cm), b.half_width_cm);
            const { free, seen } = reachable(cfg, spin);
            expect(free(cfg.start.x, cfg.start.y), "the robot can turn on the spot at the start").toBe(true);
            if (cfg.terrain) {
              // The search below sees the floor plan only: on terrain it is a necessary condition, not a proof (an
              // edge too high, a slope too steep or a fall are not walls to it, and a bridge narrower than a spin is
              // a wall to it). A terrain world is proven by driving it: terrain-worlds.test.ts drives its route here.
              expect(Object.keys(ROUTES), `${cfg.name} has a scripted route`).toContain(cfg.name);
            }
            const unreached = [
              ...cfg.zones
                .filter((z) => z.label && !base.includes(z))
                .filter((z) => !reaches(cfg, seen, (x, y) => inRect(x, y, z)))
                .map((z) => `zone ${z.label}`),
              ...cfg.points
                .filter((p) => !reaches(cfg, seen, (x, y) => Math.hypot(x - p.x, y - p.y) <= p.radius))
                .map((p) => `point ${p.label}`),
            ];
            expect(unreached).toEqual([]);
          });
      });

    test("a running twin switches to each world by name and refuses an unknown one with the list", async () => {
      const twin = loadConfig(["--twin", d.robots[0]!, "--world", d.worlds[0]!]).robots[0]!;
      if (twin.source !== "twin") throw new Error("not a twin");
      const { brick, sim } = twinRuntime(twin);
      const idle = new AbortController().signal;
      for (const f of d.worlds) {
        const name = basename(f, ".json");
        const r = await sim.command("sim.world", "use_map", { map: name }, idle);
        expect(r.measured.world).toBe(name);
        expect(brick.world.cfg.name).toBe(name);
        // the robot keeps its own footprint in every room
        expect(brick.world.cfg.body).toEqual(parseWorld(twin.world).body);
      }
      await expect(sim.command("sim.world", "use_map", { map: "no-such-world" }, idle)).rejects.toThrow(
        d.worlds.map((f) => basename(f, ".json")).join(", "),
      );
    });
  });

describe("the maps of a folder: the world files next to --world", () => {
  const robot = join(REPO, "deployments", "example", "robots", "r1.json");
  const room = readFileSync(join(REPO, "apps", "local", "examples", "room.json"), "utf8");
  const folder = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "spinecord-maps-"));
    writeFileSync(join(dir, "room.json"), room);
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    return dir;
  };
  const maps = (dir: string): string[] => {
    const twin = loadConfig(["--twin", robot, "--world", join(dir, "room.json")]).robots[0]!;
    if (twin.source !== "twin") throw new Error("not a twin");
    return Object.keys(twin.worlds ?? {});
  };

  test("only regular world files count; anything else there is left alone and never stops the start", () => {
    const other = JSON.stringify({ ...JSON.parse(room), name: "other" });
    const dir = folder({
      "other.json": other,
      "notes.json": "{ half a file",
      "tsconfig.json": '{ // comments\n "compilerOptions": {} }',
      "package.json": '{"name": "x"}',
      "big.json": `{"pad": "${"x".repeat(MAX_SIBLING_WORLD_BYTES)}", "schema": "spinecord/world@1"}`,
      "readme.txt": "not json",
    });
    mkdirSync(join(dir, "dir.json"));
    try {
      symlinkSync(join(dir, "nowhere.json"), join(dir, "dangling.json"));
    } catch {
      // a system that does not let this user make links (Windows without developer mode): nothing to check there
    }
    try {
      expect(maps(dir)).toEqual(["other", "room"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("names are file names in Unicode NFC, .json in any case; a name unlike the one inside is listed", async () => {
    const world = (name: string) => JSON.stringify({ ...JSON.parse(room), name });
    const decomposed = "cancio\u0301n"; // "canción" as a zip may write it
    const dir = folder({ [`${decomposed}.json`]: world("canción"), "OTRO.JSON": world("otro") });
    try {
      const twin = loadConfig(["--twin", robot, "--world", join(dir, "room.json")]).robots[0]!;
      if (twin.source !== "twin") throw new Error("not a twin");
      const names = Object.keys(twin.worlds ?? {});
      // a file system that keeps names as written (APFS, NTFS) lists it decomposed; the key is composed either way
      expect(names).toEqual(expect.arrayContaining(["canción", "OTRO", "room"]));
      expect(mapNameMismatches(twin.worlds ?? {})).toEqual([{ map: "OTRO", name: "otro" }]);
      const { sim } = twinRuntime(twin);
      const idle = new AbortController().signal;
      for (const typed of ["canción", decomposed])
        expect((await sim.command("sim.world", "use_map", { map: typed }, idle)).measured.world).toBe("canción");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file that declares the world schema and is not a valid world ends the start, naming it", () => {
    for (const [text, why] of [
      ['{"schema": "spinecord/world@1", "name": "x",', "is not valid JSON"],
      [JSON.stringify({ ...JSON.parse(room), arena: {} }), "arena.width_cm"],
      [JSON.stringify({ ...JSON.parse(room), description: "" }), "description"],
    ] as const) {
      const dir = folder({ "broken.json": text });
      try {
        expect(() => maps(dir)).toThrow(why);
        expect(() => maps(dir)).toThrow(join(dir, "broken.json"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("use_map answers what the person does in that map, and the map list carries it", async () => {
    const d = deployments[0]!;
    const twin = loadConfig(["--twin", d.robots[0]!, "--world", d.worlds[0]!]).robots[0]!;
    if (twin.source !== "twin") throw new Error("not a twin");
    const { sim } = twinRuntime(twin);
    const idle = new AbortController().signal;
    const spec = (await sim.devices()).find((x) => x.id === "sim.world")!;
    const use = spec.commands.find((c) => c.name === "use_map")!.description;
    for (const f of d.worlds) {
      const desc = parseWorld(JSON.parse(readFileSync(f, "utf8"))).description;
      if (desc === undefined) continue;
      const name = basename(f, ".json");
      expect(use).toContain(`${name} (${desc})`);
      const r = await sim.command("sim.world", "use_map", { map: name }, idle);
      expect(r.measured.description).toBe(desc);
      expect((await sim.command("sim.world", "load_world", { world: name }, idle)).measured.description).toBe(desc);
      // a reset or a restore keeps the room: nothing new to tell
      expect((await sim.command("sim.world", "reset", {}, idle)).measured.description).toBeUndefined();
      expect((await sim.command("sim.world", "restore", {}, idle)).measured.description).toBeUndefined();
    }
  });
});

describe("a map a person picks is the room restore goes back to", () => {
  const ORUGAS = join(REPO, "deployments", "orugas", "robots", "orugas.json");
  const SALA = join(REPO, "deployments", "orugas", "worlds", "sala.json");
  const LABERINTO = parseWorld(
    JSON.parse(readFileSync(join(REPO, "deployments", "orugas", "worlds", "laberinto.json"), "utf8")),
  );
  const idle = new AbortController().signal;
  const twinIn = (world: string) => {
    const twin = loadConfig(["--twin", ORUGAS, "--world", world]).robots[0]!;
    if (twin.source !== "twin") throw new Error("not a twin");
    return { twin, ...twinRuntime(twin) };
  };
  const boxes = (w: World) => w.cfg.boxes.map((b) => [b.id, b.x, b.y, b.w, b.h]);

  test("use_map laberinto, a box moved, restore: laberinto as its file has it, not sala", async () => {
    const { brick, sim } = twinIn(SALA);
    await sim.command("sim.world", "use_map", { map: "laberinto" }, idle);
    const own = boxes(brick.world);
    brick.world.moveObstacle("muro_h1", { x: 120, y: 160, w: 30, h: 4 });
    expect(boxes(brick.world)).not.toEqual(own);
    const r = await sim.command("sim.world", "restore", {}, idle);
    expect(r.measured.world).toBe("laberinto");
    expect(brick.world.cfg.name).toBe("laberinto");
    expect(boxes(brick.world)).toEqual(own);
    expect(brick.world.cfg.boxes.length).toBe(LABERINTO.boxes.length);
    expect(brick.world.pose).toEqual(LABERINTO.start);
  });

  test("load_world after use_map is an edit: restore still returns to the map the person picked", async () => {
    const { brick, sim } = twinIn(SALA);
    await sim.command("sim.world", "use_map", { map: "laberinto" }, idle);
    await sim.command("sim.world", "load_world", { world: "slalom" }, idle);
    expect(brick.world.cfg.name).toBe("slalom");
    await sim.command("sim.world", "restore", {}, idle);
    expect(brick.world.cfg.name).toBe("laberinto");
    // and load_world by name alone never makes a map the origin
    const fresh = twinIn(SALA);
    await fresh.sim.command("sim.world", "load_world", { world: "laberinto" }, idle);
    await fresh.sim.command("sim.world", "restore", {}, idle);
    expect(fresh.brick.world.cfg.name).toBe("sala");
  });

  test("a failed use_map changes neither the room nor the one restore goes back to", async () => {
    const { brick, sim } = twinIn(SALA);
    await sim.command("sim.world", "use_map", { map: "laberinto" }, idle);
    await expect(sim.command("sim.world", "use_map", { map: "nope" }, idle)).rejects.toThrow("unknown world");
    expect(brick.world.cfg.name).toBe("laberinto");
    await sim.command("sim.world", "restore", {}, idle);
    expect(brick.world.cfg.name).toBe("laberinto");
  });

  test("use_map is refused with busy while the robot moves, and the room stays", async () => {
    const { twin, runtime, brick } = twinIn(SALA);
    const robot = new LocalRobot({ id: twin.id });
    await robot.attach(runtime);
    try {
      const drive = callTool([robot], "drive", { robot_id: twin.id, distance_cm: 30, speed_pct: 20 });
      const sw = await callTool([robot], "command_device", {
        robot_id: twin.id,
        device: "sim.world",
        command: "use_map",
        args: { map: "laberinto" },
      });
      expect(sw.envelope.ok).toBe(false);
      expect((sw.envelope as { error: { code: string } }).error.code).toBe("busy");
      expect(brick.world.cfg.name).toBe("sala");
      await callTool([robot], "stop", { robot_id: twin.id });
      await drive;
    } finally {
      await robot.shutdown();
    }
  });
});
