// The rays of the simulated sensors, drawn as the physics casts them (state.rays, src/messages.ts SensorRays):
// quiet lines from the distance sensor's real place and height, one clear mark where each reading comes from (the
// ultrasonic's echo, the infrared ray that sends back the most light), and the colour sensor's spot on the mat.
// Everything here is in the robot's frame: x ahead, y up, z to its right (three.js), cm.
import * as THREE from "three";
import type { SensorRays } from "./messages";

const DEG = Math.PI / 180;
const US_COLOUR = 0x3ccf7a;
const IR_COLOUR = 0xff5a7a;
const SPOT_COLOUR = 0x2f7bff;

/** The end of a ray of `cm` along bearing `deg` (left positive) from (ahead, z), in the robot's frame. */
export function rayEnd(from: { ahead_cm: number; z_cm: number }, deg: number, cm: number): [number, number, number] {
  return [from.ahead_cm + Math.cos(deg * DEG) * cm, from.z_cm, -Math.sin(deg * DEG) * cm];
}

/** The ray whose light the infrared reading mostly comes from (the largest share); null for no rays. */
export function irMark(ir: SensorRays["ir"]): { deg: number; cm: number } | null {
  if (!ir || ir.rays.length === 0) return null;
  return ir.rays.reduce((a, b) => (b.share > a.share ? b : a));
}

export class SensorRayView {
  readonly group = new THREE.Group();
  private readonly us: THREE.LineSegments;
  private readonly usFan: THREE.Mesh;
  private readonly usEcho: THREE.Mesh;
  private readonly ir: THREE.LineSegments;
  private readonly irDot: THREE.Mesh;
  private readonly spot: THREE.Mesh;
  private readonly usPos = new Float32Array(16 * 6);
  private readonly fanPos = new Float32Array(17 * 3);
  private readonly irPos = new Float32Array(16 * 6);

  constructor() {
    const line = (pos: Float32Array, colour: number, opacity: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const l = new THREE.LineSegments(
        g,
        new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity, depthWrite: false }),
      );
      l.frustumCulled = false;
      return l;
    };
    this.us = line(this.usPos, US_COLOUR, 0.35);
    this.ir = line(this.irPos, IR_COLOUR, 0.35);
    const fan = new THREE.BufferGeometry();
    fan.setAttribute("position", new THREE.BufferAttribute(this.fanPos, 3));
    this.usFan = new THREE.Mesh(
      fan,
      new THREE.MeshBasicMaterial({
        color: US_COLOUR,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.usFan.frustumCulled = false;
    const dot = (colour: number) =>
      new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 12), new THREE.MeshBasicMaterial({ color: colour }));
    this.usEcho = dot(US_COLOUR);
    this.irDot = dot(IR_COLOUR);
    this.spot = new THREE.Mesh(
      new THREE.RingGeometry(0.75, 1, 32),
      new THREE.MeshBasicMaterial({ color: SPOT_COLOUR, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.spot.rotation.x = -Math.PI / 2;
    this.group.add(this.usFan, this.us, this.usEcho, this.ir, this.irDot, this.spot);
  }

  update(r: SensorRays): void {
    const f = r.from;
    const o: [number, number, number] = [f.ahead_cm, f.z_cm, 0];
    // ultrasonic: every even ray, the fan through their ends, the echo the reading comes from
    const u = r.ultrasonic;
    this.us.visible = this.usFan.visible = u !== null;
    this.usEcho.visible = u?.echo != null;
    if (u) {
      const fanIdx: number[] = [];
      this.fanPos.set(o, 0);
      u.rays.forEach((ray, i) => {
        const e = rayEnd(f, ray.deg, ray.cm);
        this.usPos.set([...o, ...e], i * 6);
        this.fanPos.set(e, (i + 1) * 3);
        if (i > 0) fanIdx.push(0, i, i + 1);
      });
      this.us.geometry.setDrawRange(0, u.rays.length * 2);
      this.us.geometry.attributes.position!.needsUpdate = true;
      const fg = this.usFan.geometry;
      if (fg.index?.count !== fanIdx.length) fg.setIndex(fanIdx);
      fg.attributes.position!.needsUpdate = true;
      if (u.echo) this.usEcho.position.set(...rayEnd(f, u.echo.deg, u.echo.cm));
    }
    // infrared: its rays, and a mark where most of its light comes back from
    const ir = r.ir;
    this.ir.visible = ir !== null;
    const m = irMark(ir);
    this.irDot.visible = m !== null;
    if (ir) {
      ir.rays.forEach((ray, i) => this.irPos.set([...o, ...rayEnd(f, ray.deg, ray.cm)], i * 6));
      this.ir.geometry.setDrawRange(0, ir.rays.length * 2);
      this.ir.geometry.attributes.position!.needsUpdate = true;
    }
    if (m) this.irDot.position.set(...rayEnd(f, m.deg, m.cm));
    // colour: the spot it averages on the mat
    this.spot.visible = r.color !== null;
    if (r.color) {
      this.spot.position.set(r.color.ahead_cm, 0.2, 0);
      this.spot.scale.setScalar(r.color.r_cm);
    }
  }

  dispose(): void {
    this.group.traverse((c) => {
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
  }
}
