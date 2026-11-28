import { describe, expect, test } from "bun:test";
import { Terrain, slopeDeg, type TerrainPiece } from "./terrain";
import { FALL_TILT_DEG, NO_NOISE, ObstacleError, World, parseWorld } from "./world";
import { readWorldChannel, worldChannelSpecs } from "./channels";
import { EXAMPLES, quietWorld } from "./testkit";

const DEG = 180 / Math.PI;
const BODY = { front_cm: 8, back_cm: 10, half_width_cm: 6 };
const ramp = (over: Partial<TerrainPiece> = {}): TerrainPiece => ({
  id: "r",
  kind: "ramp",
  x: 50,
  y: 0,
  w: 40,
  h: 100,
  low_cm: 0,
  high_cm: 10,
  rises: "east",
  ...over,
});
const platform = (over: Partial<TerrainPiece> = {}): TerrainPiece => ({
  id: "p",
  kind: "platform",
  x: 90,
  y: 0,
  w: 40,
  h: 100,
  low_cm: 10,
  high_cm: 10,
  ...over,
});

/** A quiet world with terrain: 200 x 100, the robot at (20, 50) facing east. */
function terrainWorld(terrain: unknown[], start = { x: 20, y: 50, heading_deg: 0 }, drive = {}): World {
  const cfg = parseWorld({
    schema: "spinecord/world@1",
    name: "t",
    arena: { width_cm: 200, height_cm: 100 },
    start,
    terrain,
  });
  return new World({ ...cfg, noise: { ...NO_NOISE } }, 1, { axle_track_cm: 12, climb_cm: 2, ...drive });
}
const RAMP_JSON = { id: "rampa", kind: "ramp", x: 50, y: 0, w: 40, h: 100, rises: "east", low_cm: 0, high_cm: 10 };
const TOP_JSON = { id: "arriba", kind: "platform", x: 90, y: 0, w: 40, h: 100, height_cm: 10 };
/** Rolls both wheels `cm` forward in steps of `step` cm (20 ms each); returns whether the last step was blocked. */
function roll(w: World, cm: number, step = 0.4): boolean {
  let blocked = false;
  for (let d = 0; d < Math.abs(cm) - 1e-9 && !blocked; d += step) {
    const s = Math.sign(cm) * Math.min(step, Math.abs(cm) - d);
    blocked = w.stepWheels(s, s, 20);
  }
  return blocked;
}

describe("terrain maths", () => {
  const t = new Terrain([ramp(), platform()]);
  test("height: the floor, along a ramp, on a platform; a ramp's slope", () => {
    expect(t.heightAt(10, 50)).toBe(0);
    expect(t.heightAt(70, 50)).toBeCloseTo(5, 9);
    expect(t.heightAt(100, 20)).toBe(10);
    expect(t.pieceAt(70, 50)).toBe("r");
    expect(t.pieceAt(10, 50)).toBeNull();
    expect(slopeDeg(ramp())).toBeCloseTo(Math.atan(10 / 40) * DEG, 9);
    for (const rises of ["west", "north", "south"] as const) {
      const p = new Terrain([ramp({ rises, w: 40, h: 40, y: 0 })]);
      const low = rises === "west" ? [89.9, 20] : rises === "north" ? [70, 0.1] : [70, 39.9];
      expect(p.heightAt(low[0]!, low[1]!)).toBeCloseTo(0, 1);
    }
  });
  test("on a ramp the body pitches by the slope; across it, it rolls by it", () => {
    const up = t.rest(70, 50, 0, BODY);
    expect(up.pitch * DEG).toBeCloseTo(Math.atan(0.25) * DEG, 6);
    expect(up.roll).toBeCloseTo(0, 9);
    expect(up.z_cm).toBeCloseTo(5, 6);
    const down = t.rest(70, 50, Math.PI, BODY);
    expect(down.pitch * DEG).toBeCloseTo(-Math.atan(0.25) * DEG, 6);
    // facing north on an east-rising ramp: the right side (east) is the higher one
    const across = t.rest(70, 50, Math.PI / 2, BODY);
    expect(across.pitch).toBeCloseTo(0, 9);
    expect(Math.tan(across.roll)).toBeCloseTo(-0.25, 6);
  });
  test("a track tips over an edge only once the axle has passed it", () => {
    const edge = new Terrain([platform({ x: 0, w: 100, low_cm: 4, high_cm: 4 })]);
    // the edge 1 cm ahead of the axle: level on top, the nose over the drop
    const before = edge.rest(99, 50, 0, BODY);
    expect(before.pitch).toBeCloseTo(0, 9);
    expect(before.z_cm).toBe(4);
    // 1 cm past it: nose down, resting on the edge and on the floor at its front
    const after = edge.rest(101, 50, 0, BODY);
    expect(after.pitch * DEG).toBeCloseTo(-Math.atan(4 / 9) * DEG, 4);
    expect(after.top_piece).toBe("p");
  });
  test("one track over a side drop rolls the body by atan(drop / track width)", () => {
    const bridge = new Terrain([platform({ x: 0, y: 40, w: 200, h: 20, low_cm: 6, high_cm: 6 })]);
    const r = bridge.rest(100, 50 + 7, 0, BODY); // the right track at y 51 on it, the left at 63 off it
    expect(r.roll * DEG).toBeCloseTo(-Math.atan(6 / 12) * DEG, 6);
  });
  test("climb: the rise of the highest edge the tracks would have to ride up", () => {
    const step = new Terrain([platform({ x: 50, w: 50, low_cm: 3, high_cm: 3 })]);
    const p0 = { x: 41, y: 50, th: 0 },
      p1 = { x: 43, y: 50, th: 0 };
    expect(step.climb(p0, step.rest(p0.x, p0.y, 0, BODY), p1, BODY)).toEqual({ rise_cm: 3, piece: "p" });
    // a smooth ramp never rises more than a step's travel times its slope
    const r = ramp(),
      on = new Terrain([r]);
    const q0 = { x: 70, y: 50, th: 0 };
    expect(on.climb(q0, on.rest(70, 50, 0, BODY), { x: 70.4, y: 50, th: 0 }, BODY).rise_cm).toBeLessThan(1e-6);
  });
  test("a ray meets a platform's side square on, a ramp's top slanted, the floor once it points down", () => {
    const side = t.ray(60, 50, 20, 1, 0, 0, 0, 500);
    // over the ramp (its top is below 20 cm): the platform's 10 cm side is below the ray, so the ray goes on to x 200
    expect(side).toBeNull();
    const low = t.ray(20, 50, 5, 1, 0, 0, 0, 500)!;
    // at 5 cm the central ray meets the ramp's top where it is 5 cm high: x 70
    expect(low.d).toBeCloseTo(50, 6);
    expect(low.cos).toBeCloseTo(Math.sin(Math.atan(0.25)), 6);
    // on the platform looking back west, above the ramp: no side faces it, the ray passes over everything
    expect(t.ray(95, 50, 12, -1, 0, 0, 0, 500)).toBeNull();
    const floor = new Terrain([platform({ x: 150, w: 10 })]).ray(20, 50, 10, 1, 0, -0.5, 0, 500)!;
    expect(floor.d).toBeCloseTo(20, 9);
    const wall = new Terrain([platform({ x: 50, w: 10 })]).ray(20, 50, 5, 1, 0, 0, 0, 500)!;
    expect(wall).toEqual({ d: 30, cos: 1, top_cm: 10 });
  });
});

describe("a world with terrain", () => {
  test("parse: kinds, fields, heights, overlaps and ids are checked, naming the field", () => {
    const base = { schema: "spinecord/world@1", name: "t", arena: { width_cm: 200, height_cm: 100 } };
    const start = { x: 20, y: 50, heading_deg: 0 };
    const bad =
      (terrain: unknown[], obstacles: unknown[] = []) =>
      () =>
        new World(parseWorld({ ...base, start, terrain, obstacles }));
    expect(bad([{ ...RAMP_JSON, kind: "hill" }])).toThrow(/terrain\[0\]\.kind must be "platform" or "ramp"/);
    expect(bad([{ ...RAMP_JSON, height_cm: 3 }])).toThrow(/terrain\[0\]\.height_cm is not a known field of a ramp/);
    expect(bad([{ ...RAMP_JSON, high_cm: 0 }])).toThrow(/terrain\[0\]\.high_cm must be above low_cm/);
    expect(bad([{ ...RAMP_JSON, rises: "up" }])).toThrow(/terrain\[0\]\.rises must be one of east, west/);
    expect(bad([{ ...TOP_JSON, height_cm: 0 }])).toThrow(/terrain\[0\]\.height_cm must be a finite number/);
    expect(bad([RAMP_JSON, { ...TOP_JSON, x: 80 }])).toThrow(/terrain\[1\] overlaps terrain "rampa"/);
    expect(bad([{ ...TOP_JSON, id: "wall_east" }])).toThrow(/names the floor, a box or a wall/);
    expect(bad([{ ...TOP_JSON, id: "floor" }])).toThrow(/names the floor, a box or a wall/);
    // a post between the tracks would pass under the body unfelt: a piece is at least as wide as the body
    expect(bad([{ ...TOP_JSON, x: 100, y: 46, w: 8, h: 8, height_cm: 20 }])).toThrow(
      /terrain "arriba" is 8 cm across; a piece is at least as wide as the body \(12 cm\)/,
    );
    expect(bad([{ ...TOP_JSON, x: 100, y: 0, w: 12, h: 100, height_cm: 20 }])).not.toThrow();
    expect(bad([{ ...TOP_JSON, x: 180 }])).toThrow(/does not lie wholly inside the arena/);
    expect(bad([TOP_JSON], [{ x: 100, y: 10, w: 5, h: 5 }])).toThrow(/box "box1" stands on terrain/);
    expect(
      () => new World(parseWorld({ ...base, start: { x: 88, y: 50, heading_deg: 0 }, terrain: [TOP_JSON] })),
    ).toThrow(/at the start pose the robot would rest tilted/);
    // touching along an edge is fine
    expect(bad([RAMP_JSON, TOP_JSON])).not.toThrow();
  });

  test("a flat world has no terrain: no rest, no terrain channels, the same channels as before", () => {
    const w = quietWorld(EXAMPLES.lineOval);
    expect(w.terrain).toBeNull();
    expect(w.rest).toBeNull();
    expect(worldChannelSpecs(w).map((s) => s.name)).not.toContain("tilt");
    expect(() => readWorldChannel(w, "tilt")).toThrow(/has no channel "tilt"/);
  });

  test("up the ramp: the pose moves cos(pitch) of the tread, tilt reads the slope, it levels out on top", () => {
    const w = terrainWorld([RAMP_JSON, TOP_JSON]);
    expect(readWorldChannel(w, "tilt")).toEqual([0, 0, 0]);
    roll(w, 50); // the axle at x 70, mid ramp
    expect(w.pose.x).toBeLessThan(70);
    expect(w.pose.x).toBeGreaterThan(69);
    const [z, pitch, rollDeg] = readWorldChannel(w, "tilt") as number[];
    expect(pitch).toBeCloseTo(Math.atan(0.25) * DEG, 1);
    expect(rollDeg).toBe(0);
    expect(z).toBeCloseTo((w.pose.x - 50) / 4, 1);
    roll(w, 40);
    expect(readWorldChannel(w, "tilt")).toEqual([10, 0, 0]);
    expect(readWorldChannel(w, "blocked_by")).toBe("");
  });

  test("a step higher than the tread climbs stops the body as a wall does; a lower one it rides up", () => {
    const low = terrainWorld([{ ...TOP_JSON, x: 50, height_cm: 1.5 }]);
    expect(roll(low, 40)).toBe(false);
    expect(low.rest!.z_cm).toBe(1.5);
    const high = terrainWorld([{ ...TOP_JSON, x: 50, height_cm: 3 }]);
    expect(roll(high, 40)).toBe(true);
    expect(high.pose.x + high.cfg.body.front_cm).toBeCloseTo(50, 3); // stopped with its nose at the edge
    expect(high.last_block).toEqual({ by: "step", with: "arriba", rise_cm: 3 });
    expect(readWorldChannel(high, "blocked_by")).toBe("step arriba 3");
    expect(readWorldChannel(high, "collided")).toBe(true);
    expect(high.eventsSince(0).events.filter((e) => e.kind === "step_blocked")).toHaveLength(1);
  });

  test("a slope steeper than the grip holds: the body climbs no higher; a gentler one it climbs", () => {
    const steep = { ...RAMP_JSON, w: 20, high_cm: 10.6 }; // 27.9 deg: above atan(0.5) = 26.6, below the fall's 30
    const top = { ...TOP_JSON, x: 70, height_cm: 10.6 };
    const w = terrainWorld([steep, top]);
    expect(roll(w, 60)).toBe(true);
    expect(w.last_block?.by).toBe("steep");
    expect(Math.atan(Math.abs(Math.tan(w.rest!.pitch)))).toBeLessThanOrEqual(Math.atan(0.5) + 1e-6);
    expect(w.eventsSince(0).events.map((e) => e.kind)).toContain("too_steep");
    // the same slope with a tread that grips at 0.7 (35 deg)
    const grippy = terrainWorld([steep, top], undefined, { grip: 0.7 });
    expect(roll(grippy, 60)).toBe(false);
    // going back down is always allowed
    expect(roll(w, -20)).toBe(false);
  });

  test("off an edge it falls: it lies there, every move is held, and a reset or a hand sets it up again", () => {
    const w = terrainWorld([{ ...TOP_JSON, x: 0, w: 100 }], { x: 60, y: 50, heading_deg: 0 });
    expect(roll(w, 45)).toBe(true);
    expect(w.fallen).toMatchObject({ from: "arriba", drop_cm: 10 });
    expect(w.fallen!.tilt_deg).toBeGreaterThan(FALL_TILT_DEG);
    // it tipped once the axle passed the edge, not before
    expect(w.pose.x).toBeGreaterThan(100);
    expect(w.pose.x).toBeLessThan(100.5);
    expect(readWorldChannel(w, "fallen")).toMatch(/^fell from arriba: dropped 10 cm, tipped \d+ deg$/);
    // the step it fell on ends stalled, blocked by the fall
    expect(w.last_stalled).toBe(true);
    expect(w.last_block).toEqual({ by: "fallen" });
    expect(readWorldChannel(w, "blocked_by")).toBe("fallen");
    const x = w.pose.x;
    expect(roll(w, -10)).toBe(true);
    expect(w.pose.x).toBe(x);
    expect(w.last_block).toEqual({ by: "fallen" });
    w.setPose({ x: 60, y: 50, th: 0 });
    expect(w.fallen).toBeNull();
    expect(w.rest!.z_cm).toBe(10);
    roll(w, 30);
    w.carry({ x: 150, y: 50, th: 0 });
    expect(w.fallen).toBeNull();
  });

  test("a gentle drop it drives down; placing it across an edge where it would tip is refused in words", () => {
    const w = terrainWorld([{ ...TOP_JSON, x: 0, w: 100, height_cm: 3 }], { x: 60, y: 50, heading_deg: 0 });
    expect(roll(w, 60)).toBe(false);
    expect(w.fallen).toBeNull();
    expect(w.rest!.z_cm).toBe(0);
    const high = terrainWorld([{ ...TOP_JSON, x: 0, w: 100 }], { x: 60, y: 50, heading_deg: 0 });
    expect(high.placeProblem({ x: 101, y: 50, th: 0 })).toMatch(
      /would rest tilted \d+ deg .* across the edge of "arriba"/,
    );
    expect(() => high.carry({ x: 101, y: 50, th: 0 })).toThrow(/carry: the robot would rest tilted/);
    expect(() => high.setPose({ x: 101, y: 50, th: 0 })).toThrow(/setPose: the robot would rest tilted/);
    // on top, overhanging its edge with the axle still on it, it stands
    expect(high.placeProblem({ x: 99, y: 50, th: 0 })).toBeNull();
  });

  test("boxes stand on the flat floor: one set on terrain is refused, a pushed box stops against it", () => {
    const w = terrainWorld([{ ...TOP_JSON, x: 80 }]);
    const on = (() => {
      try {
        w.addObstacle({ x: 100, y: 10, w: 5, h: 5 });
      } catch (e) {
        return e as ObstacleError;
      }
    })();
    expect(on?.code).toBe("on_terrain");
    // a light box between the robot and the platform: pushed up to the platform's edge, then the robot stalls
    w.addObstacle({ id: "caja", x: 50, y: 45, w: 10, h: 10, mass_g: 100 });
    expect(roll(w, 60)).toBe(true);
    expect(w.obstacle("caja")!.x + 10).toBeCloseTo(80, 3);
    expect(w.last_block).toEqual({ by: "contact" });
  });

  test("the distance sensor rides on the tilted body: pitched down, its beam finds the floor", () => {
    // facing down the ramp from on top: the IR beam, pitched down by the slope, meets the floor ahead
    const w = terrainWorld(
      [
        { ...RAMP_JSON, rises: "west" },
        { ...TOP_JSON, x: 10, w: 40 },
      ],
      { x: 40, y: 50, heading_deg: 0 },
    );
    const flat = w.rayDistance();
    roll(w, 25); // on the ramp, nose down 14 deg
    expect(w.rest!.pitch * DEG).toBeLessThan(-13);
    const down = w.rayHit();
    expect(down.d).toBeLessThan(flat - 100);
    // the sensor (6 cm up, 8 ahead) sees the floor where its tilted central ray comes down to it
    expect(down.d).toBeGreaterThan(20);
    expect(down.d).toBeLessThan(45);
    // a platform's side ahead at the sensor's height: seen square on
    const facing = terrainWorld([{ ...TOP_JSON, x: 80, height_cm: 20 }]);
    expect(facing.rayHit()).toMatchObject({ d: 80 - 20 - 8, cos: 1, top_cm: 20 });
  });

  test("how a viewer cuts the steps does not move where the body stops at a step or where it falls", () => {
    const end = (cut: (i: number) => number) => {
      const w = terrainWorld(
        [
          { ...TOP_JSON, x: 0, w: 100 },
          { id: "muro", kind: "platform", x: 140, y: 0, w: 12, h: 100, height_cm: 5 },
        ],
        {
          x: 60,
          y: 50,
          heading_deg: 0,
        },
      );
      let i = 0;
      while (!w.fallen && i < 2000) {
        const ms = cut(i++);
        w.stepWheels((20 * ms) / 1000, (20 * ms) / 1000, ms);
      }
      return { x: w.pose.x, t: w.t_ms };
    };
    const even = end(() => 20),
      uneven = end((i) => [3, 17, 7, 11, 20][i % 5]!);
    expect(Math.abs(even.x - uneven.x)).toBeLessThan(1e-3); // the fall is bisected inside the step it happens in
    const stop = (cut: (i: number) => number) => {
      const w = terrainWorld([{ ...TOP_JSON, x: 50, height_cm: 3 }]);
      for (let i = 0; i < 400; i++) {
        const ms = cut(i);
        w.stepWheels((20 * ms) / 1000, (20 * ms) / 1000, ms);
      }
      return w.pose.x;
    };
    expect(stop(() => 20)).toBeCloseTo(
      stop((i) => [3, 17, 7, 11, 20][i % 5]!),
      3,
    );
  });

  test("the ultrasonic hears a box corner in plain view, and not through a platform standing in front of it", () => {
    const echo = (terrain: unknown[]) => {
      const cfg = parseWorld({
        schema: "spinecord/world@1",
        name: "c",
        arena: { width_cm: 200, height_cm: 150 },
        start: { x: 30, y: 30, heading_deg: 45 },
        obstacles: [{ x: 70, y: 70, w: 20, h: 20 }],
        terrain,
      });
      return new World({ ...cfg, noise: { ...NO_NOISE } }, 1).coneEcho();
    };
    // seen at 45 deg the box's faces send nothing back; its corner (70, 70) does
    expect(echo([]).d).toBeCloseTo(Math.hypot(70 - 30 - 8 / Math.SQRT2, 70 - 30 - 8 / Math.SQRT2), 6);
    // a 20 cm platform on the line to it, its faces seen at 45 deg too: no echo at all
    expect(echo([{ id: "p", kind: "platform", x: 48, y: 48, w: 14, h: 14, height_cm: 20 }]).d).toBe(Infinity);
  });

  test("cost: a physics step on terrain stays far below its 20 ms", () => {
    const w = terrainWorld([
      RAMP_JSON,
      TOP_JSON,
      { id: "b", kind: "platform", x: 140, y: 0, w: 30, h: 40, height_cm: 4 },
    ]);
    const t0 = performance.now();
    let n = 0;
    for (; n < 500; n++) w.stepWheels(0.3, 0.32, 20);
    const per = (performance.now() - t0) / n;
    expect(per).toBeLessThan(2);
  });

  test("rays off the terrain are those of a flat world: walls and boxes as rayHit casts them", () => {
    // one rayHit casts both: terrain a ray does not reach leaves walls and boxes as a flat world has them
    // the eye off the centre line and turned (distanceSensorAxis) is where both start, on either kind of world
    for (const body of [{}, { distance_sensor_y_cm: 3, distance_sensor_yaw_deg: 30 }]) {
      const flatCfg = parseWorld({
        schema: "spinecord/world@1",
        name: "f",
        arena: { width_cm: 200, height_cm: 100 },
        start: { x: 20, y: 50, heading_deg: 0 },
        body,
        obstacles: [
          { x: 120, y: 40, w: 20, h: 20, height_cm: 4 },
          { x: 60, y: 70, w: 10, h: 10 },
          { x: 150, y: 10, w: 15, h: 30, height_cm: 30, ir_reflectivity: 0.3 },
        ],
      });
      const flat = new World({ ...flatCfg, noise: { ...NO_NOISE } }, 1);
      const hilly = new World(
        { ...flatCfg, noise: { ...NO_NOISE }, terrain: [{ ...platform({ x: 0, y: 88, w: 12, h: 12 }) }] },
        1,
      );
      for (const p of [
        { x: 20, y: 50, th: 0 },
        { x: 40, y: 30, th: 0.4 },
        { x: 100, y: 50, th: -0.2 },
        { x: 80, y: 20, th: 1.2 },
      ]) {
        expect(hilly.sensorAt(p)).toEqual(flat.sensorAt(p));
        expect(hilly.coneEcho(p)).toEqual(flat.coneEcho(p));
        for (const off of [-0.4, -0.1, 0, 0.2, 0.43])
          for (const v of [(12 * Math.PI) / 180, (25 * Math.PI) / 180, Math.PI / 2]) {
            const a = flat.rayHit(p, off, v),
              b = hilly.rayHit(p, off, v);
            expect(b.d).toBeCloseTo(a.d, 9);
            expect(b.cos).toBeCloseTo(a.cos, 9);
            expect(b.ir).toBe(a.ir);
          }
      }
    }
  });

  test("a clone keeps the terrain and how the body lies", () => {
    const w = terrainWorld([RAMP_JSON, TOP_JSON]);
    roll(w, 50);
    const c = w.clone();
    expect(c.terrain!.pieces).toEqual(w.terrain!.pieces);
    expect(c.rest).toEqual(w.rest);
  });
});
