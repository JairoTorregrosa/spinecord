// The real meshes of the EV3's parts, converted from the LDraw parts library by scripts/ldraw-meshes.ts and served
// next to the page (meshes/<part>.bin.gz). A robot is drawn at once from its procedural parts; meanwhile each
// registered part (parts.ts `real`) fetches its mesh, and when it arrives the mesh takes the place of the part's
// procedural shapes. When every mesh of a robot is in place the page sets the performance mark "twin:meshes", so
// a test or a person in the console can time the first complete frame. The parts that move or change stay alive on it: a motor's hub turns, the touch
// sensor's button travels, the brick's buttons and its LED light up, its screen is drawn from the state.
//
// A mesh that cannot load leaves the part as it was drawn and says why in the console: the page goes on.
// Decoded geometries are kept for the page's life (at most one per part kind, a few MB), so switching robots or
// worlds fetches and uploads nothing twice and the GPU's memory does not grow.
//
// The meshes are © the LDraw library's authors, CC BY 4.0, modified: meshes/ATTRIBUTION.md, linked from the page.
import * as THREE from "three";
import { ldrawMatrix } from "./dims";
import { decode, type Decoded, type Group } from "./mesh-format";
import { REAL } from "./mesh-parts";
import { link } from "./deeplink";
import { P, type Kit } from "./parts";

const loading = new Map<string, Promise<Decoded>>();
const reported = new Set<string>();

async function fetchPart(part: string): Promise<Decoded> {
  const res = await fetch(`meshes/${part}.bin.gz`);
  if (!res.ok || !res.body) throw new Error(`meshes/${part}.bin.gz: HTTP ${res.status}`);
  const buf = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  return decode(part, buf);
}

/** Loads the real meshes of the parts `kit` registered and puts each in place, unless `alive()` turns false
 *  first (the robot was replaced). */
export function loadReal(kit: Kit, alive: () => boolean): Promise<void> {
  if (!link.meshes) return Promise.resolve();
  credit();
  const mats = new Map<string, THREE.Material>();
  const material = (g: Group): THREE.Material => {
    const key = `${g.rgb}|${g.alpha}|${g.double}`;
    let m = mats.get(key);
    if (!m) {
      const chrome = g.colour === 383 || g.colour === 494; // chrome silver, electric contact alloy
      m = kit.keep(
        new THREE.MeshStandardMaterial({
          color: g.rgb,
          roughness: chrome ? 0.25 : 0.32,
          metalness: chrome ? 0.85 : 0,
          transparent: g.alpha < 1,
          opacity: g.alpha,
          side: g.double ? THREE.DoubleSide : THREE.FrontSide,
        }),
      );
      mats.set(key, m);
    }
    return m;
  };
  const jobs = kit.reals
    .filter((r) => REAL.has(r.ldraw))
    .map(async (r) => {
      let p = loading.get(r.ldraw);
      if (!p) {
        loading.set(r.ldraw, (p = fetchPart(r.ldraw)));
        p.catch(() => loading.delete(r.ldraw));
      }
      let d: Decoded;
      try {
        d = await p;
      } catch (e) {
        if (!reported.has(r.ldraw))
          console.error(`the real mesh of ${r.ldraw} did not load; it stays drawn from boxes:`, e);
        reported.add(r.ldraw);
        return;
      }
      if (!alive()) return;
      // LDraw (LDU) → the part's frame (cm, robot-style axes) → three.js axes inside the holder
      const toHolder = new THREE.Matrix4()
        .makeBasis(P(1, 0, 0), P(0, 1, 0), P(0, 0, 1))
        .multiply(new THREE.Matrix4().fromArray(ldrawMatrix(r.frame, r.bottomLdu ?? 0)));
      const placeIn = (target: THREE.Object3D, rest: THREE.Matrix4 | null) => {
        clearProcedural(target, kit);
        const holder = new THREE.Group();
        holder.matrixAutoUpdate = false;
        holder.matrix.copy(rest ? rest.clone().invert().multiply(toHolder) : toHolder);
        holder.name = `real ${r.ldraw}`;
        target.add(holder);
        return holder;
      };
      const into = new Map<string, THREE.Object3D>();
      for (const g of d.groups) {
        const role = g.role !== "body" && r.roles?.[g.role] ? g.role : "body";
        let at = into.get(role);
        if (!at) {
          const t = role === "body" ? r.holder : r.roles![role]!.target;
          into.set(role, (at = placeIn(t, role === "body" ? null : r.rest[role]!)));
        }
        const mesh = new THREE.Mesh(g.geometry, r.roles?.[role]?.material ?? material(g));
        mesh.castShadow = mesh.receiveShadow = true;
        at.add(mesh);
      }
    });
  return Promise.all(jobs).then(() => {
    if (alive()) performance.mark("twin:meshes");
  });
}

/** Takes away a holder's procedural shapes: every child that is not live (live ones move or change, and stay). */
function clearProcedural(o: THREE.Object3D, kit: Kit): void {
  for (const c of [...o.children]) if (!kit.isLive(c) && !c.name.startsWith("real ")) c.removeFromParent();
}

/** The LDraw library's licence asks for its authors to be credited where its parts are shown: a small line on the
 *  page with a link to the attribution, added once. */
function credit(): void {
  if (document.getElementById("ldraw-credit")) return;
  const a = document.createElement("a");
  a.id = "ldraw-credit";
  a.href = "meshes/ATTRIBUTION.md";
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = "Piezas 3D: biblioteca LDraw, CC BY 4.0 (modificadas)";
  a.style.cssText =
    "position:fixed;left:50%;bottom:2px;transform:translateX(-50%);z-index:5;font:10px system-ui,sans-serif;" +
    "color:#0009;background:#fff6;padding:0 5px;border-radius:3px;text-decoration:none";
  document.body.append(a);
}
