import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { fitDistance, robotSphere, viewOffset, type Area } from "./camera";

// the page at 1280 x 720 with its panels: tools on the left, the brick on the right, the calls below
const W = 1280,
  H = 720;
const free: Area = { left: 216, top: 70, right: 1004, bottom: 484 };

describe("framing the robot in the part of the canvas no panel covers", () => {
  test("the view offset puts the optical centre at the free area's centre", () => {
    const o = viewOffset(W, H, free);
    const cx = (free.left + free.right) / 2,
      cy = (free.top + free.bottom) / 2;
    // the larger image's centre, seen from the canvas, is the free area's centre; the canvas lies inside it
    expect(o.fullW / 2 - o.x).toBeCloseTo(cx);
    expect(o.fullH / 2 - o.y).toBeCloseTo(cy);
    expect(o.x).toBeGreaterThanOrEqual(0);
    expect(o.y).toBeGreaterThanOrEqual(0);
    expect(o.x + W).toBeLessThanOrEqual(o.fullW + 1e-9);
    expect(o.y + H).toBeLessThanOrEqual(o.fullH + 1e-9);
  });

  test("at the fitted distance the robot's sphere projects inside the free area, wherever the robot is", () => {
    const extent = { front_cm: 12, back_cm: 8, half_width_cm: 8, height_cm: 24 };
    for (const [w, h, f] of [
      [1280, 720, free],
      [1728, 1117, { left: 216, top: 70, right: 1416, bottom: 798 }],
      [1600, 1000, { left: 216, top: 70, right: 1292, bottom: 700 }],
    ] as [number, number, Area][]) {
      for (const pose of [
        { x: 38, y: 40, th: 0 },
        { x: 111, y: 60, th: 2 },
      ]) {
        const s = robotSphere(pose, extent);
        const d = fitDistance(s.r, 45, w, h, f);
        const cam = new THREE.PerspectiveCamera(45, 1, 1, 5000);
        const o = viewOffset(w, h, f);
        cam.aspect = o.fullW / o.fullH;
        cam.setViewOffset(o.fullW, o.fullH, o.x, o.y, w, h);
        // behind and above the robot, looking at its centre
        const centre = new THREE.Vector3(s.x, s.y, s.z);
        const a = pose.th + Math.PI + (32 * Math.PI) / 180,
          el = (38 * Math.PI) / 180;
        cam.position.set(
          s.x + Math.cos(a) * Math.cos(el) * d,
          s.y + Math.sin(el) * d,
          s.z - Math.sin(a) * Math.cos(el) * d,
        );
        cam.lookAt(centre);
        cam.updateMatrixWorld();
        // the centre lands at the free area's centre, and points of the sphere stay inside the free area
        const px = (v: THREE.Vector3) => {
          const p = v.clone().project(cam);
          return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h };
        };
        const c = px(centre);
        expect(c.x).toBeCloseTo((f.left + f.right) / 2, 0);
        expect(c.y).toBeCloseTo((f.top + f.bottom) / 2, 0);
        for (const dir of [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 1, 0],
          [0, -1, 0],
          [0, 0, 1],
          [0, 0, -1],
        ]) {
          const q = px(centre.clone().add(new THREE.Vector3(...(dir as [number, number, number])).multiplyScalar(s.r)));
          expect(q.x).toBeGreaterThan(f.left);
          expect(q.x).toBeLessThan(f.right);
          expect(q.y).toBeGreaterThan(f.top);
          expect(q.y).toBeLessThan(f.bottom);
        }
      }
    }
  });

  test("the sphere is centred on the bounding box, not the axle, and holds what stands on top", () => {
    const s = robotSphere({ x: 50, y: 50, th: 0 }, { front_cm: 14, back_cm: 6, half_width_cm: 7, height_cm: 30 });
    expect(s.x).toBeCloseTo(54); // 4 cm ahead of the axle
    expect(s.y).toBeCloseTo(15); // half its height
    expect(s.r).toBeCloseTo(Math.hypot(20, 14, 30) / 2);
  });
});
