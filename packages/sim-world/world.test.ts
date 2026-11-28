import { test, expect, describe } from "bun:test";
import { World, parseWorld, COLOR, NO_NOISE, WORLD_SCHEMA } from "./world";
import { join } from "node:path";
import { loadWorldFile } from "./world-file";
import { EXAMPLES, DRIVE, config, quietWorld } from "./testkit";

describe("world files", () => {
  test("both examples load from disk: environment and sensor placement, no drivetrain", async () => {
    for (const name of ["line-oval", "walls-maze"]) {
      const cfg = await loadWorldFile(join(import.meta.dir, "examples", `${name}.json`));
      expect(cfg.name).toBe(name);
      expect(cfg.body).toEqual({
        front_cm: 8,
        back_cm: 10,
        half_width_cm: 6,
        color_sensor_x_cm: 7,
        color_spot_radius_cm: 1,
        distance_sensor_x_cm: 8,
        distance_sensor_y_cm: 0,
        distance_sensor_yaw_deg: 0,
        distance_sensor_z_cm: 6,
        touch_z_cm: 0,
      });
      expect(JSON.stringify(cfg)).not.toMatch(/wheel_diameter|axle_track/);
      expect(new World(cfg, 1).drive).toBeNull();
    }
  });
  test("wheel geometry in a world file is refused: it belongs to the robot profile", () => {
    const base = structuredClone(EXAMPLES.lineOval) as Record<string, any>;
    expect(() => parseWorld({ ...base, robot: { wheel_diameter_cm: 5.6 } })).toThrow(/come from the robot profile/);
    expect(() => parseWorld({ ...base, body: { axle_track_cm: 12 } })).toThrow(
      /body\.axle_track_cm is not a known field/,
    );
    expect(parseWorld({ ...base, body: { color_sensor_x_cm: 3 } }).body.color_sensor_x_cm).toBe(3);
    expect(() => parseWorld({ ...base, points: [{ label: "a b", x: 1, y: 1, radius_cm: 2 }] })).toThrow(
      /may only use letters/,
    );
  });
  test("a bad file fails naming the field", () => {
    const base = structuredClone(EXAMPLES.lineOval) as Record<string, any>;
    expect(() => parseWorld({ ...base, schema: "x" })).toThrow(/schema must be "spinecord\/world@1"/);
    expect(() => parseWorld({ ...base, arena: { width_cm: 120 } })).toThrow(/arena\.height_cm/);
    expect(() => parseWorld({ ...base, zones: [{ x: 0, y: 0, w: 1, h: 1, color: "pink" }] })).toThrow(
      /zones\[0\]\.color/,
    );
    expect(() => parseWorld({ ...base, brick: {} })).toThrow(/brick is not a known section/);
    expect(() => parseWorld({ ...base, noise: { wobble: 1 } })).toThrow(/noise\.wobble/);
    expect(() =>
      parseWorld({
        ...base,
        points: [
          { label: "A", x: 1, y: 1, radius_cm: 2 },
          { label: "A", x: 2, y: 2, radius_cm: 2 },
        ],
      }),
    ).toThrow(/repeated/);
    expect(() => new World(parseWorld({ ...base, start: { x: 2, y: 2, heading_deg: 0 } }), 1)).toThrow(
      /does not fit at the start pose \(2, 2\)/,
    );
    expect(() => parseWorld({ schema: WORLD_SCHEMA })).toThrow(/arena must be an object/);
  });
  test("loadWorldFile fails loud on a missing file", async () => {
    await expect(loadWorldFile(join(import.meta.dir, "examples", "no-such-world.json"))).rejects.toThrow(/cannot read/);
  });
});

describe("physics", () => {
  test("same seed, same trajectory; another seed differs", () => {
    const run = (seed: number) => {
      const w = new World(config(), seed, DRIVE);
      w.advance(30, 30, 20);
      w.advance(-5, 5, 10);
      w.advance(10, 10, 20);
      return w.pose;
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });
  test("drives straight the commanded distance without noise", () => {
    const w = quietWorld();
    const r = w.advance(20, 20, 20);
    expect(r.stalled).toBe(false);
    expect(w.pose.x).toBeCloseTo(63, 6);
    expect(w.pose.y).toBeCloseTo(25, 6);
    expect(r.ms).toBeCloseTo(1000, 3);
  });
  test("turning left is positive: wheel arcs rotate the robot about the axle", () => {
    const w = quietWorld();
    const arc = (Math.PI / 2) * 6;
    w.advance(-arc, arc, 10);
    expect((w.pose.th * 180) / Math.PI).toBeCloseTo(90, 6);
    expect(w.senseGyro()).toBe(90);
    expect(w.pose.x).toBeCloseTo(43, 6);
  });
  test("a wall stops the robot: stalled, and it never passes through", () => {
    const w = quietWorld();
    const r = w.advance(200, 200, 25);
    expect(r.stalled).toBe(true);
    expect(w.pose.x).toBeLessThanOrEqual(112);
    expect(w.pose.x).toBeGreaterThan(110);
    expect(r.left_cm).toBeLessThan(70);
    expect(w.senseTouch()).toBe(1);
  });
  test("a drive into a wall ends in contact with it, and the wheel travel reported is the travel done", () => {
    const w = quietWorld(); // front of the body at x 51, the wall at 120
    const r = w.advance(200, 200, 25);
    expect(120 - (w.pose.x + w.cfg.body.front_cm)).toBeLessThan(0.01);
    expect(r.left_cm).toBeCloseTo(w.pose.x - 43, 2);
    // at a slant the corner comes to rest on the wall
    const v = quietWorld();
    v.setPose({ x: 90, y: 40, th: Math.PI / 6 });
    expect(v.advance(50, 50, 25).stalled).toBe(true);
    expect(Math.max(...v.corners().map(([x]) => x))).toBeGreaterThan(119.99);
  });
  test("a tracked base with turn_scrub 0.2 turns 80 % of what its encoders say; driving straight is untouched", () => {
    const w = new World(config(EXAMPLES.lineOval, { noise: { ...NO_NOISE } }), 1, { ...DRIVE, turn_scrub: 0.2 });
    const arc = (Math.PI / 2) * (DRIVE.axle_track_cm / 2); // each wheel's travel for 90 deg by the encoders
    const r = w.advance(-arc, arc, 10);
    expect(r.right_cm).toBeCloseTo(arc, 6); // the encoders report what the motors turned
    expect((w.pose.th * 180) / Math.PI).toBeCloseTo(72, 6);
    w.setPose({ x: 43, y: 25, th: 0 });
    w.advance(30, 30, 20);
    expect(w.pose.x).toBeCloseTo(73, 6);
    expect(() => new World(config(), 1, { ...DRIVE, turn_scrub: 1 })).toThrow(
      /turn_scrub must be 0 or more and below 1/,
    );
    // the scrub belongs to the robot, not to the room: a world file that says it is refused, naming its new home
    expect(() => parseWorld({ ...EXAMPLES.lineOval, noise: { turn_scrub: 0.2 } })).toThrow(
      /noise.turn_scrub is not a field of the room.*twin.drive.turn_scrub/,
    );
  });
  test("an obstacle blocks too", () => {
    const w = quietWorld();
    w.setPose({ x: 30, y: 45, th: 0 });
    expect(w.advance(60, 60, 25).stalled).toBe(true);
    expect(w.pose.x + 8).toBeLessThanOrEqual(55);
    expect(w.pose.x + 8).toBeGreaterThan(53.5);
  });
  test("the axle track comes from the drive geometry handed in; without one the wheels cannot roll the body", () => {
    const wide = new World(config(), 1, { axle_track_cm: 24 }),
      narrow = quietWorld();
    const arc = (Math.PI / 2) * 6;
    wide.cfg.noise.motor = 0; // same config object is not shared: config() parses afresh
    narrow.advance(-arc, arc, 10);
    wide.advance(-arc, arc, 10);
    expect((narrow.pose.th * 180) / Math.PI).toBeCloseTo(90, 6);
    expect(Math.abs((wide.pose.th * 180) / Math.PI - 45)).toBeLessThan(2); // twice the track, half the turn
    const none = new World(config(), 1);
    expect(() => none.advance(5, 5, 10)).toThrow(/no drivetrain geometry/);
    expect(none.pose).toEqual({ x: 43, y: 25, th: 0 });
    expect(() => new World(config(), 1, { axle_track_cm: 0 })).toThrow(/axle_track_cm must be > 0/);
    expect(narrow.clone().drive).toEqual(DRIVE);
  });
  test("trip meters: the odometer ignores spins, line travel follows the line, a teleport zeroes both", () => {
    const w = quietWorld();
    w.advance(20, 20, 20);
    expect(w.odometer_cm).toBeCloseTo(20, 6);
    expect(w.line_travel_cm).toBeCloseTo(20, 1); // the start pose sits on the line, heading along it
    w.advance(-9, 9, 10);
    expect(w.odometer_cm).toBeCloseTo(20, 6);
    w.advance(9, -9, 10);
    w.advance(-5, -5, 20);
    expect(w.odometer_cm).toBeCloseTo(25, 6);
    expect(w.line_travel_cm).toBeCloseTo(15, 1);
    const noisy = new World(config(), 2, DRIVE);
    for (let i = 0; i < 20; i++) noisy.advance(-1.57, 1.57, 20); // spinning with wheel noise is still not travel
    expect(noisy.odometer_cm).toBe(0);
    w.setPose({ x: 60, y: 15, th: 0 });
    expect([w.odometer_cm, w.line_travel_cm]).toEqual([0, 0]);
  });
  test("noise is small by default", () => {
    const w = new World(config(), 3, DRIVE);
    w.advance(50, 50, 20);
    expect(Math.abs(w.pose.x - 93)).toBeLessThan(2.5);
    expect(Math.abs(w.pose.x - 93)).toBeGreaterThan(0);
  });
});

describe("sensors", () => {
  test("color: black on the line, white off it, zone colours by id", () => {
    const w = quietWorld();
    expect(w.senseColorId()).toBe(COLOR.black); // start: sensor (7 cm ahead) over the line
    expect(w.senseReflect()).toBe(6);
    w.setPose({ x: 43, y: 35, th: 0 });
    expect(w.senseColorId()).toBe(COLOR.white);
    expect(w.senseReflect()).toBe(85);
    w.setPose({ x: 15, y: 30, th: -Math.PI / 2 }); // sensor at (15, 23): zone D (yellow)
    expect(w.senseColorId()).toBe(COLOR.yellow);
    w.setPose({ x: 15, y: 60, th: Math.PI / 2 }); // sensor at (15, 67): zone A (red)
    expect(w.senseColorId()).toBe(COLOR.red);
  });
  test("reflect is intermediate on the edge of the line", () => {
    const w = quietWorld();
    w.setPose({ x: 43, y: 26.5, th: 0 }); // sensor centre exactly on the line edge (line 25 ± 1.5)
    const r = w.senseReflect();
    expect(r).toBeGreaterThan(25);
    expect(r).toBeLessThan(70);
  });
  test("ultrasonic: distance from the sensor to the wall, clamped at 3 cm", () => {
    const w = quietWorld();
    expect(w.senseUltrasonic()).toBeCloseTo(120 - 43 - 8, 1);
    w.advance(200, 200, 25);
    expect(w.senseUltrasonic()).toBe(3);
  });
  test("ultrasonic sees the obstacle, and the cone catches what a single ray misses", () => {
    const w = quietWorld();
    w.setPose({ x: 30, y: 45, th: 0 });
    expect(w.senseUltrasonic()).toBeCloseTo(55 - 38, 1);
    w.setPose({ x: 30, y: 52, th: 0 }); // straight ray passes 2 cm above the box
    expect(w.rayDistance()).toBeCloseTo(120 - 38, 1);
    expect(w.senseUltrasonic()).toBeLessThan(25);
  });
  // A 300 x 300 cm room with one wall the tests aim at (x 300): nothing else falls in the infrared beam.
  const room = (seed?: number) => {
    const json = { ...EXAMPLES.lineOval, arena: { width_cm: 300, height_cm: 300 }, obstacles: [] };
    return seed === undefined ? quietWorld(json) : new World(config(json), seed, DRIVE);
  };
  /** Sensor `cm` from the wall at x 300 along its axis, the axis `deg` off the wall's normal. */
  const aim = (w: World, cm: number, deg = 0) => {
    const th = (deg * Math.PI) / 180,
      ahead = w.cfg.body.distance_sensor_x_cm;
    w.setPose({ x: 300 - (ahead + cm) * Math.cos(th), y: 150 - (ahead + cm) * Math.sin(th), th });
  };
  test("IR proximity of a large wall square on reads about its distance in cm: 41 at 38 cm, 100 with nothing in range", () => {
    const w = room();
    const at = (cm: number) => (aim(w, cm), w.senseIrProximity());
    expect(at(38)).toBe(41); // EV3-G read 40-41 at 38 cm from a white wall
    expect(at(10)).toBe(11);
    expect(at(30)).toBe(32);
    expect(at(60)).toBe(64);
    expect(at(100)).toBe(100);
  });
  test("IR proximity is not linear in distance: a slanted wall or an object smaller than the beam reads farther", () => {
    const w = room();
    aim(w, 30);
    const square = w.irProximity();
    aim(w, 30, 40);
    expect(w.rayDistance()).toBeCloseTo(30, 6);
    expect(w.irProximity()).toBeGreaterThan(square + 2); // about 11 % farther at 40 deg
    // a 10 cm box 20 cm ahead fills only part of the beam
    const b = quietWorld({
      ...EXAMPLES.lineOval,
      arena: { width_cm: 300, height_cm: 300 },
      obstacles: [{ x: 150, y: 145, w: 10, h: 10 }],
    });
    b.setPose({ x: 150 - 20 - 8, y: 150, th: 0 });
    expect(b.rayDistance()).toBeCloseTo(20, 6);
    expect(b.irProximity()).toBeGreaterThan(20 * (40.5 / 38) + 1); // about 10 % farther than a wall at 20 cm
  });
  test("IR proximity depends on what the surface sends back: black (ir_reflectivity 0.21) reads 88-90 at 38 cm", () => {
    // a wide box against the room's far wall, faced square on: it fills the beam as the wall does
    const wall = (ir?: number) =>
      quietWorld({
        ...EXAMPLES.lineOval,
        arena: { width_cm: 300, height_cm: 300 },
        obstacles: [{ id: "panel", x: 290, y: 0, w: 10, h: 300, ...(ir === undefined ? {} : { ir_reflectivity: ir }) }],
      });
    const at = (w: World, cm: number) => {
      const ahead = w.cfg.body.distance_sensor_x_cm;
      w.setPose({ x: 290 - ahead - cm, y: 150, th: 0 });
      return w.senseIrProximity();
    };
    expect(at(wall(), 38)).toBe(41); // absent: white, as before
    expect(at(wall(1), 38)).toBe(41);
    const black = at(wall(0.21), 38);
    expect(black).toBeGreaterThanOrEqual(88); // EV3-G read 88-90 from black at 38 cm (issue518)
    expect(black).toBeLessThanOrEqual(90);
    expect(at(wall(0.21), 60)).toBe(100); // a dark thing goes out of range sooner
    // the ultrasonic and the camera do not see the colour
    const w = wall(0.21);
    at(w, 38);
    expect(w.rayDistance()).toBeCloseTo(38, 6);
    expect(() => wall(0)).toThrow(/ir_reflectivity/);
    expect(() => wall(1.5)).toThrow(/at most 1/);
    expect(() => wall(1).addObstacle({ x: 10, y: 10, w: 5, h: 5, ir_reflectivity: 2 })).toThrow(/ir_reflectivity/);
    const id = wall(1).addObstacle({ x: 10, y: 10, w: 5, h: 5, ir_reflectivity: 0.5 });
    expect(id).toBe("box1");
  });
  test("IR noise grows with the reading", () => {
    const spread = (cm: number) => {
      const w = room(7);
      aim(w, cm);
      const v = Array.from({ length: 400 }, () => w.senseIrProximity());
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
    };
    expect(spread(70)).toBeGreaterThan(1.5 * spread(20));
    // with nothing within reach it reads 100 every time, noise or not
    const far = room(7);
    aim(far, 150);
    expect(new Set(Array.from({ length: 200 }, () => far.senseIrProximity()))).toEqual(new Set([100]));
  });
  test("ultrasonic: a wall square on echoes, one slanted 20 deg still does, one at 60 deg gives no echo (255)", () => {
    const w = room();
    const look = (deg: number) => (aim(w, 40, deg), w.senseUltrasonic());
    expect(look(0)).toBeCloseTo(40, 1);
    expect(look(20)).toBeLessThan(45);
    expect(look(30)).toBe(255);
    expect(look(60)).toBe(255);
    // and nothing in range reads 255 too: the far wall 292 cm away
    w.setPose({ x: 0 + 10.5, y: 150, th: 0 });
    expect(w.senseUltrasonic()).toBe(255);
  });
  test("ultrasonic: a box corner echoes at any angle within reach, where its slanted faces give nothing back", () => {
    const w = quietWorld({
      ...EXAMPLES.lineOval,
      arena: { width_cm: 300, height_cm: 300 },
      obstacles: [{ x: 150, y: 140, w: 20, h: 20 }],
    });
    /** Sensor `cm` from the box's lower left corner, looking straight at it at 45 deg to both its faces. */
    const at = (cm: number) => {
      const ahead = w.cfg.body.distance_sensor_x_cm + cm;
      w.setPose({ x: 150 - ahead * Math.SQRT1_2, y: 140 - ahead * Math.SQRT1_2, th: Math.PI / 4 });
      return w.senseUltrasonic();
    };
    expect(at(40)).toBeCloseTo(40, 1);
    expect(at(25)).toBeCloseTo(25, 1);
    expect(at(70)).toBe(255); // past ULTRASONIC_EDGE_MAX_CM an edge is too faint, and the faces stay silent
  });
  test("ultrasonic: a 5 cm post anywhere inside the cone is seen, also between the cone's evenly spaced rays", () => {
    const at = (d: number, lateral: number) => {
      const w = quietWorld({
        ...EXAMPLES.lineOval,
        arena: { width_cm: 600, height_cm: 300 },
        obstacles: [{ x: 100 + d, y: 150 + lateral - 2.5, w: 5, h: 5 }],
      });
      w.setPose({ x: 100 - w.cfg.body.distance_sensor_x_cm, y: 150, th: 0 });
      return w.ultrasonicCm();
    };
    let missed = 0,
      tried = 0;
    for (const d of [100, 150, 200, 250 - 6])
      for (let lat = -d * Math.tan((11 * Math.PI) / 180); lat <= d * Math.tan((11 * Math.PI) / 180); lat += 0.5) {
        tried++;
        if (at(d, lat) > Math.hypot(d, Math.max(0, Math.abs(lat) - 2.5)) + 1) missed++; // its near face echoes
      }
    expect(tried).toBeGreaterThan(200);
    expect(missed).toBe(0);
    expect(at(150, 0)).toBeCloseTo(150, 0);
  });
  test("ultrasonic: a room corner (two walls square to each other) echoes from any angle within reach", () => {
    const w = quietWorld({ ...EXAMPLES.lineOval, arena: { width_cm: 300, height_cm: 300 }, obstacles: [] });
    /** Sensor `cm` from the room's corner at (300, 300), looking straight into it at 45 deg to both walls. */
    const at = (cm: number) => {
      const ahead = w.cfg.body.distance_sensor_x_cm + cm;
      w.setPose({ x: 300 - ahead * Math.SQRT1_2, y: 300 - ahead * Math.SQRT1_2, th: Math.PI / 4 });
      return w.ultrasonicCm();
    };
    expect(at(40)).toBeCloseTo(40, 0); // the walls alone, at 45 deg, give nothing back
    expect(at(55)).toBeCloseTo(55, 0);
    expect(at(80)).toBe(255); // past ULTRASONIC_CORNER_MAX_CM (not measured, kept short)
  });
  test("a gyro reset while the robot turns drifts by the rate it had; reset while still, it does not", () => {
    const w = quietWorld();
    w.stepWheels(-0.5, 0.5, 20); // turning left at about 240 deg/s
    w.resetGyro();
    w.wait(1000); // still, for a second
    expect(w.senseGyro()).toBeLessThan(-200);
    w.resetGyro(); // still now: a good zero
    w.wait(1000);
    expect(w.senseGyro()).toBe(0);
  });
  test("the gyro is within +-3 deg on a 90 deg turn for most seeds, off by its own scale error", () => {
    const errors = Array.from({ length: 100 }, (_, seed) => {
      const w = new World(config(EXAMPLES.lineOval, { noise: { ...NO_NOISE, gyro_scale: 0.017 } }), seed, DRIVE);
      w.advance(-Math.PI * 3, Math.PI * 3, 10); // exactly 90 deg on a 12 cm axle
      return w.peekGyroDeg() - 90;
    });
    expect(errors.filter((e) => Math.abs(e) <= 3).length).toBeGreaterThanOrEqual(90);
    expect(errors.some((e) => Math.abs(e) > 0.5)).toBe(true);
  });
  test("sensor noise is seeded and does not disturb the motion", () => {
    const a = new World(config(), 5, DRIVE),
      b = new World(config(), 5, DRIVE);
    for (let i = 0; i < 20; i++) a.senseUltrasonic();
    a.advance(20, 20, 20);
    b.advance(20, 20, 20);
    expect(a.pose).toEqual(b.pose);
  });
  test("named points are data; an unknown label fails listing the known ones", () => {
    const w = quietWorld();
    expect(w.point("A")).toEqual({ label: "A", x: 15, y: 75, radius: 9 });
    expect(() => w.point("kitchen")).toThrow(/unknown point "kitchen".*A, B, C, D/);
  });
});

describe("the distance sensor's pose: its eye off the centre line and its heading turned", () => {
  const room = (body: object, boxes: object[] = []) =>
    new World(
      parseWorld({
        schema: WORLD_SCHEMA,
        name: "pose",
        arena: { width_cm: 200, height_cm: 200 },
        start: { x: 100, y: 100, heading_deg: 0 },
        obstacles: boxes,
        noise: { ...NO_NOISE },
        body: { distance_sensor_x_cm: 6, ...body },
      }),
      1,
      DRIVE,
    );
  test("every ray starts at the eye and leaves along its heading; the reading is that ray's", () => {
    // eye 6 ahead, 5 to the right, looking 90 degrees right of ahead: straight at the wall at y 0
    const w = room({ distance_sensor_y_cm: -5, distance_sensor_yaw_deg: -90 });
    const a = w.distanceSensorAxis();
    expect(a.o[0]).toBeCloseTo(106, 9);
    expect(a.o[1]).toBeCloseTo(95, 9);
    expect(a.th).toBeCloseTo(-Math.PI / 2, 9);
    expect(w.rayDistance()).toBeCloseTo(95, 6);
    expect(w.coneDistance()).toBeCloseTo(95, 6);
    // the robot turned: the sensor turns with it
    w.setPose({ x: 100, y: 100, th: Math.PI / 2 });
    expect(w.distanceSensorAxis().o[0]).toBeCloseTo(105, 9);
    expect(w.rayDistance()).toBeCloseTo(95, 6); // now looking along +x, from x 105
  });
  test("a box beside the centre line is seen by an eye on that side, looking ahead, and missed from the centre", () => {
    const box = [{ x: 140, y: 108, w: 10, h: 6 }];
    const side = room({ distance_sensor_y_cm: 11 }, box);
    expect(side.rayDistance()).toBeCloseTo(140 - 106, 6);
    expect(room({}, box).rayDistance()).toBeCloseTo(200 - 106, 6);
    // the infrared's light comes back mostly along the ray that meets it
    expect(side.irProximity()).toBeLessThan(room({}, box).irProximity());
  });
  test("a sensor at the back looking back reads what is behind the robot, from its own eye", () => {
    const w = room({ back_cm: 12, distance_sensor_x_cm: -10, distance_sensor_yaw_deg: 180 });
    const a = w.distanceSensorAxis();
    expect(a.o[0]).toBeCloseTo(90, 9);
    expect(a.o[1]).toBeCloseTo(100, 9);
    expect(w.rayDistance()).toBeCloseTo(90, 6); // to the wall at x 0
    expect(w.coneDistance()).toBeCloseTo(90, 6);
    // past the front of the body neither
    expect(() => room({ front_cm: 8, distance_sensor_x_cm: 9 })).toThrow(
      "body.distance_sensor_x_cm is 9: the distance sensor's eye would be 9 cm ahead of the axle, past the front of the body (front_cm 8)",
    );
    // past the back of the body is no place for it: refused in plain words
    expect(() => room({ back_cm: 12, distance_sensor_x_cm: -13 })).toThrow(
      "body.distance_sensor_x_cm is -13: the distance sensor's eye would be 13 cm behind the axle, past the back of the body (back_cm 12)",
    );
  });
  test("the side may be negative, the heading only within -180..180", () => {
    expect(room({ distance_sensor_y_cm: -3 }).cfg.body.distance_sensor_y_cm).toBe(-3);
    expect(() => room({ distance_sensor_yaw_deg: 270 })).toThrow(/distance_sensor_yaw_deg/);
    expect(() => room({ distance_sensor_x_cm: -11 })).toThrow(/distance_sensor_x_cm/); // back_cm 10 by default
  });
});
