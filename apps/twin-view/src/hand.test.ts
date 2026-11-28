// The hand on a page without a browser: a canvas 200 × 200 px that only keeps its listeners, a document with the
// few elements the hand and the notes write to, and real three.js rays. Two cameras: one straight above the
// 200 × 200 cm floor, where a pixel is a centimetre (clientX = x, clientY = 200 - y), and one low on the side,
// looking along +x at y = 40, where what is nearer hides what is behind it.
import { beforeEach, describe, expect, test } from "bun:test";
import * as THREE from "three";
import type { Arena } from "./arena";
import type { Cameras } from "./camera";
import type { Mode } from "./hand";
import type { Link, Reply } from "./link";
import type { Obstacle, PageMessage, RobotMeta } from "./messages";

class El {
  textContent = "";
  className = "";
  hidden = true;
  style: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
}
const els = new Map<string, El>();
const g = globalThis as Record<string, unknown>;
g.document = {
  getElementById: (id: string) => els.get(id) ?? els.set(id, new El()).get(id)!,
  querySelectorAll: () => [],
};
g.innerWidth ??= 1000;
g.addEventListener ??= () => {};
g.removeEventListener ??= () => {};
g.matchMedia ??= () => ({ matches: false, addEventListener() {} });
const { Hand } = await import("./hand");

type Px = { cx: number; cy: number };
type Ev = { stopped: boolean };
type Listener = (e: Record<string, unknown>) => void;
class Canvas {
  dataset: Record<string, string> = {};
  classList = { add() {}, remove() {} };
  private readonly on = new Map<string, Listener[]>();
  addEventListener(t: string, f: Listener) {
    this.on.set(t, [...(this.on.get(t) ?? []), f]);
  }
  getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  setPointerCapture() {}
  hasPointerCapture = () => false;
  releasePointerCapture() {}
  fire(type: string, at: Px, id = 1, pointerType = "mouse"): Ev {
    const e = {
      type,
      button: 0,
      pointerId: id,
      pointerType,
      clientX: at.cx,
      clientY: at.cy,
      shiftKey: false,
      stopped: false,
      stopImmediatePropagation() {
        e.stopped = true;
      },
      preventDefault() {},
    };
    for (const f of this.on.get(type) ?? []) f(e);
    return e;
  }
}

/** Floor point (x, y) cm under the top camera. */
const top = (x: number, y: number): Px => ({ cx: x, cy: 200 - y });
const BOX: Obstacle = { id: "b1", x: 120, y: 120, w: 20, h: 20 };
const meta = (boxes: Obstacle[]): RobotMeta =>
  ({
    id: "r1",
    name: null,
    drivetrain: null,
    ports: { motors: {}, sensors: {} },
    world: {
      name: "test",
      width: 200,
      height: 200,
      boxes,
      zones: [],
      lines: [],
      points: [],
      body: {
        front_cm: 8,
        back_cm: 8,
        half_width_cm: 6,
        color_sensor_x_cm: 5,
        color_spot_radius_cm: 1,
        distance_sensor_x_cm: 6,
        distance_sensor_z_cm: 8,
      },
      start: { x: 40, y: 40, heading_deg: 0 },
    },
  }) as unknown as RobotMeta;

function topCamera(): THREE.Camera {
  const c = new THREE.OrthographicCamera(-100, 100, 100, -100, 1, 1000);
  c.position.set(100, 500, -100);
  c.up.set(0, 0, -1);
  c.lookAt(100, 0, -100);
  c.updateMatrixWorld();
  return c;
}
function sideCamera(): THREE.Camera {
  const c = new THREE.PerspectiveCamera(50, 1, 1, 1000);
  c.position.set(-100, 15, -40);
  c.lookAt(100, 5, -40);
  c.updateMatrixWorld();
  return c;
}

function setup(mode: Mode, o: { answer?: Reply; boxes?: Obstacle[]; camera?: THREE.Camera } = {}) {
  const scene = new THREE.Scene();
  const camera = o.camera ?? topCamera();
  const m = meta((o.boxes ?? [BOX]).map((b) => ({ ...b })));
  const boxes = m.world.boxes.map((b) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, 14, b.h));
    mesh.position.set(b.x + b.w / 2, 7, -(b.y + b.h / 2));
    mesh.userData.id = b.id;
    mesh.updateMatrixWorld();
    return mesh;
  });
  const robot = new THREE.Mesh(new THREE.BoxGeometry(16, 10, 12));
  robot.position.set(40, 5, -40);
  robot.updateMatrixWorld();
  const sent: object[] = [];
  const link = {
    request: (a: Omit<PageMessage, "req">) => {
      sent.push(a);
      return Promise.resolve(o.answer ?? { ok: true });
    },
  } as unknown as Link;
  const canvas = new Canvas();
  const hand = new Hand({
    canvas: canvas as unknown as HTMLCanvasElement,
    camera,
    scene,
    cams: { mode: "top", handBusy() {} } as unknown as Cameras,
    link,
    focus: () => m,
    pose: () => ({ x: 40, y: 40, th: 0 }),
    arena: () => ({ boxes, highlight() {} }) as unknown as Arena,
    robot: () => robot,
    helpers: 1,
  });
  hand.setMode(mode);
  /** Where scene point (x, y, h) cm is drawn on the canvas. */
  const screen = (x: number, y: number, h: number): Px => {
    const v = new THREE.Vector3(x, h, -y).project(camera);
    return { cx: ((v.x + 1) / 2) * 200, cy: ((1 - v.y) / 2) * 200 };
  };
  const drag = (a: Px, b: Px): Ev => {
    const down = canvas.fire("pointerdown", a);
    canvas.fire("pointermove", { cx: (a.cx + b.cx) / 2, cy: (a.cy + b.cy) / 2 });
    canvas.fire("pointermove", b);
    canvas.fire("pointerup", b);
    return down;
  };
  const hover = (a: Px) => {
    canvas.fire("pointermove", a);
    return canvas.dataset.hover;
  };
  return { sent, drag, hover, canvas, screen };
}
/** What the hand sent, to the tenth of a centimetre (the floor point comes through a ray). */
const tenths = (a: object) =>
  Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 10) / 10 : v]));
const settle = () => new Promise((r) => setTimeout(r, 0));
const toast = () => els.get("toast")!;

beforeEach(() => {
  els.clear();
});

describe("a press on a box moves that box, in every mode that moves things", () => {
  for (const mode of ["carry", "look", "box"] as const) {
    test(`${mode}: dragging the box sends box_move with its new place`, async () => {
      const { sent, drag, hover } = setup(mode);
      expect(hover(top(130, 130))).toBe("box");
      const down = drag(top(130, 130), top(150, 100));
      await settle();
      expect(down.stopped).toBe(true); // the camera does not orbit with it
      expect(sent.map(tenths)).toEqual([{ t: "box_move", id: "r1", box: "b1", x: 140, y: 90, w: 20, h: 20 }]);
    });
  }

  test("carry: a press on the floor still places the robot there", async () => {
    const { sent, drag, hover } = setup("carry");
    expect(hover(top(80, 60))).toBe("");
    drag(top(80, 60), top(100, 60));
    await settle();
    expect(sent).toHaveLength(1);
    expect(tenths(sent[0]!)).toMatchObject({ t: "carry", id: "r1", x: 80, y: 60, heading_deg: 0 });
  });

  test("look: a press on the floor is the camera's, not the hand's", async () => {
    const { sent, drag } = setup("look");
    const down = drag(top(80, 160), top(100, 170));
    await settle();
    expect(down.stopped).toBe(false);
    expect(sent).toEqual([]);
  });

  test("a box dropped on the robot is refused in the box's words, and nothing is sent", async () => {
    const { sent, drag } = setup("carry");
    drag(top(130, 130), top(40, 40));
    await settle();
    expect(sent).toEqual([]);
    expect(toast().textContent).toContain("La caja");
    expect(toast().textContent).not.toContain("El robot se queda");
    expect(toast().textContent).not.toContain("No cabe: chocaría");
  });

  test("a move the process refuses is answered about the box", async () => {
    const { sent, drag } = setup("carry", { answer: { ok: false, code: "no_such_box", error: "no box" } });
    drag(top(130, 130), top(150, 100));
    await settle();
    expect(sent[0]).toMatchObject({ t: "box_move", box: "b1" });
    expect(toast().textContent).toContain("Esa caja");
    expect(toast().textContent).not.toContain("El robot");
  });
});

describe("what a press takes is what is nearest the camera, and the hover says the same", () => {
  // seen from the side: b0 stands between the camera and the robot, b2 behind the robot
  const boxes: Obstacle[] = [
    { id: "b0", x: 10, y: 30, w: 20, h: 20 },
    { id: "b2", x: 60, y: 30, w: 20, h: 20 },
  ];
  for (const mode of ["look", "carry"] as const) {
    test(`${mode}: a box that hides the robot is the box pressed`, async () => {
      const { sent, drag, hover, screen } = setup(mode, { boxes, camera: sideCamera() });
      const robot = screen(40, 40, 5);
      expect(hover(robot)).toBe("box");
      drag(robot, { cx: robot.cx + 30, cy: robot.cy });
      await settle();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ t: "box_move", box: "b0" });
      expect(els.get("toast")?.textContent ?? "").not.toContain("El robot se queda");
    });
  }
  test("look: the robot in front of a box is the robot pressed", async () => {
    const { sent, drag, hover, screen } = setup("look", { boxes: [boxes[1]!], camera: sideCamera() });
    const robot = screen(40, 40, 5);
    expect(hover(robot)).toBe("robot");
    drag(robot, robot); // lifted and set down where it was
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: "carry", id: "r1" });
  });
});

describe("the modes that do not move boxes, and a second finger", () => {
  test("remove: a press on a box takes that box away", async () => {
    const { sent, drag, hover } = setup("remove");
    expect(hover(top(130, 130))).toBe("box");
    drag(top(130, 130), top(130, 130));
    await settle();
    expect(sent).toEqual([{ t: "box_remove", id: "r1", box: "b1" }]);
  });
  test("measure: a press on a box measures and leaves the box where it is", async () => {
    const { sent, drag, hover } = setup("measure");
    expect(hover(top(130, 130))).toBe("");
    const down = drag(top(130, 130), top(160, 130));
    await settle();
    expect(down.stopped).toBe(true);
    expect(sent).toEqual([]);
    expect(els.get("tag")!.textContent).toContain("30.0 cm");
  });
  test("look: a second finger on a box while the first turns the camera is the camera's pinch", async () => {
    const { sent, canvas } = setup("look");
    const first = canvas.fire("pointerdown", top(80, 160), 1, "touch");
    const second = canvas.fire("pointerdown", top(130, 130), 2, "touch");
    expect(first.stopped).toBe(false);
    expect(second.stopped).toBe(false);
    canvas.fire("pointermove", top(150, 100), 2, "touch");
    canvas.fire("pointerup", top(150, 100), 2, "touch");
    canvas.fire("pointerup", top(80, 160), 1, "touch");
    await settle();
    expect(sent).toEqual([]);
    // both fingers up: the next press on the box is the hand's again
    expect(canvas.fire("pointerdown", top(130, 130), 3, "touch").stopped).toBe(true);
  });
});
