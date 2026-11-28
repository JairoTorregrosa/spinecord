// The hand on a page without a browser: a canvas that only keeps its listeners, a document with the few elements
// the hand and the notes write to, and a camera straight above a 200 × 200 cm floor, so a pixel is a centimetre
// (clientX = x, clientY = 200 - y).
import { beforeEach, describe, expect, test } from "bun:test";
import * as THREE from "three";
import type { Arena } from "./arena";
import type { Cameras } from "./camera";
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
  /** A pointer event at floor point (x, y) cm. */
  fire(type: string, x: number, y: number) {
    const e = {
      type,
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      clientX: x,
      clientY: 200 - y,
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

function setup(mode: "look" | "carry" | "box", answer: Reply = { ok: true }) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 1, 1000);
  camera.position.set(100, 500, -100);
  camera.up.set(0, 0, -1);
  camera.lookAt(100, 0, -100);
  camera.updateMatrixWorld();
  const m = meta([{ ...BOX }]);
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
  const sent: Omit<PageMessage, "req">[] = [];
  const link = {
    request: (a: Omit<PageMessage, "req">) => {
      sent.push(a);
      return Promise.resolve(answer);
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
  const drag = (x0: number, y0: number, x1: number, y1: number) => {
    const down = canvas.fire("pointerdown", x0, y0);
    canvas.fire("pointermove", (x0 + x1) / 2, (y0 + y1) / 2);
    canvas.fire("pointermove", x1, y1);
    canvas.fire("pointerup", x1, y1);
    return down;
  };
  return { sent, drag };
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
      const { sent, drag } = setup(mode);
      const down = drag(130, 130, 150, 100);
      await settle();
      expect(down.stopped).toBe(true); // the camera does not orbit with it
      expect(sent.map(tenths)).toEqual([{ t: "box_move", id: "r1", box: "b1", x: 140, y: 90, w: 20, h: 20 }]);
    });
  }

  test("carry: a press on the floor still places the robot there", async () => {
    const { sent, drag } = setup("carry");
    drag(80, 60, 100, 60);
    await settle();
    expect(sent).toHaveLength(1);
    expect(tenths(sent[0]!)).toMatchObject({ t: "carry", id: "r1", x: 80, y: 60, heading_deg: 0 });
  });

  test("look: a press on the floor is the camera's, not the hand's", async () => {
    const { sent, drag } = setup("look");
    const down = drag(80, 160, 100, 170);
    await settle();
    expect(down.stopped).toBe(false);
    expect(sent).toEqual([]);
  });

  test("a box dropped on the robot is refused in the box's words, and nothing is sent", async () => {
    const { sent, drag } = setup("carry");
    drag(130, 130, 40, 40);
    await settle();
    expect(sent).toEqual([]);
    expect(toast().textContent).toContain("La caja");
    expect(toast().textContent).not.toContain("El robot se queda");
    expect(toast().textContent).not.toContain("No cabe: chocaría");
  });

  test("a move the process refuses is answered about the box", async () => {
    const { sent, drag } = setup("carry", { ok: false, code: "no_such_box", error: "no box" });
    drag(130, 130, 150, 100);
    await settle();
    expect(sent[0]).toMatchObject({ t: "box_move", box: "b1" });
    expect(toast().textContent).toContain("Esa caja");
    expect(toast().textContent).not.toContain("El robot");
  });
});
