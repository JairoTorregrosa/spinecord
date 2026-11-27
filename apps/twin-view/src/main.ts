// The 3D view of the twins: one socket to the spinecord process (apps/local --view), the scene, and the hand of
// the person watching. The twin runs in the process; this page only shows it and asks it for what a person
// does to a robot on the floor (pick it up, set boxes down, press a button).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { buildArena, toScene, type Arena } from "./arena";
import { applyLink, frameStats, placeCamera } from "./deeplink";
import { Sound } from "./audio";
import * as hud from "./hud";
import { lookOf } from "./look";
import type { Box, PageMessage, RobotMeta, RobotState, ServerMessage } from "./messages";
import { buildRobot, P, type RobotModel } from "./model";

const $ = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`the page has no #${id}`);
  return e as T;
};
const DEG = Math.PI / 180;
const HELPERS = 1; // layer of what only the person sees: rays, trail, ghosts

// ---------------------------------------------------------------- renderer, scene, lights
const canvas = $<HTMLCanvasElement>("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
// 1.5 device pixels per CSS pixel: past that an integrated GPU pays in fill rate for detail nobody sees
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
// the sun's shadow does not depend on the camera: drawn once a frame and shared by the robot's camera
renderer.shadowMap.autoUpdate = false;
// Neutral keeps LEGO's saturated colours and white plastic white, where ACES turns them grey and yellow
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
const scene = new THREE.Scene();
// a bright room around the arena, the fog melting the far floor into it
const ROOM = 0xc9c6bf;
scene.background = new THREE.Color(ROOM);
scene.fog = new THREE.Fog(ROOM, 500, 2000);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xeef2ff, 0x5a5048, 0.9));
// the window's light: warm, from high up at a slant, with soft shadows
const sun = new THREE.DirectionalLight(0xfff1de, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.radius = 3;
sun.shadow.blurSamples = 12;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 8000);
camera.layers.enable(HELPERS);
/** The robot's own camera (the phone when it has one): layer 0 only, so it never sees the helpers. */
const eyeCam = new THREE.PerspectiveCamera(64, 16 / 9, 0.8, 4000);

// ---------------------------------------------------------------- what the page holds
let robots: RobotMeta[] = [];
let focus: RobotMeta | null = null;
let arena: Arena | null = null;
let model: RobotModel | null = null;
const robotRoot = new THREE.Group();
scene.add(robotRoot);
/** The latest state, and what is on screen now: the scene glides from `from` to `cur` over one interval. */
let cur: RobotState | null = null;
let curAt = 0;
let interval = 33;
type Shown = { x: number; y: number; th: number; tachos: Record<string, number> };
let from: Shown | null = null;
let shown: Shown | null = null;
let roles: Record<string, string> = {};
const sound = new Sound();

// ---------------------------------------------------------------- the distance sensor's cone
const conePos = new Float32Array(4 * 3);
const coneGeo = new THREE.BufferGeometry();
coneGeo.setAttribute("position", new THREE.BufferAttribute(conePos, 3));
coneGeo.setIndex([0, 1, 2, 0, 2, 3]);
const coneMat = new THREE.MeshBasicMaterial({
  color: 0x3ccf7a,
  transparent: true,
  opacity: 0.16,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const cone = new THREE.Mesh(coneGeo, coneMat);
const rayPos = new Float32Array(6 * 3);
const rayGeo = new THREE.BufferGeometry();
rayGeo.setAttribute("position", new THREE.BufferAttribute(rayPos, 3));
const rays = new THREE.LineSegments(
  rayGeo,
  new THREE.LineBasicMaterial({ color: 0x3ccf7a, transparent: true, opacity: 0.7 }),
);
const hitGeo = new THREE.SphereGeometry(0.9, 14, 10);
const hits = [0, 1, 2].map(() => new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ color: 0x3ccf7a })));
const coneGroup = new THREE.Group();
coneGroup.add(cone, rays, ...hits);
robotRoot.add(coneGroup);
cone.frustumCulled = rays.frustumCulled = false;

// ---------------------------------------------------------------- trail
const TRAIL_MAX = 6000;
const trailPos = new Float32Array(TRAIL_MAX * 3);
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
trailGeo.setDrawRange(0, 0);
const trail = new THREE.Line(
  trailGeo,
  new THREE.LineBasicMaterial({ color: 0xe3000b, transparent: true, opacity: 0.8 }),
);
trail.frustumCulled = false;
scene.add(trail);
let trailN = 0;
const trailReset = () => {
  trailN = 0;
  trailGeo.setDrawRange(0, 0);
};
const trailAdd = (x: number, y: number) => {
  if (trailN > 0) {
    const i = (trailN - 1) * 3;
    if (Math.hypot(trailPos[i]! - x, -trailPos[i + 2]! - y) < 0.4) return;
  }
  if (trailN >= TRAIL_MAX) {
    trailPos.copyWithin(0, 3 * (TRAIL_MAX / 2));
    trailN = TRAIL_MAX / 2;
  }
  trailPos.set([x, 0.12, -y], trailN * 3);
  trailN++;
  trailGeo.setDrawRange(0, trailN);
  trailGeo.attributes.position!.needsUpdate = true;
};

// ---------------------------------------------------------------- ghosts of what the hand is doing
const ghostRobot = new THREE.Group();
const ghostMat = new THREE.LineBasicMaterial({ color: 0x6fb3ff });
const ghostOutline = new THREE.LineLoop(new THREE.BufferGeometry(), ghostMat);
const ghostArrow = new THREE.Line(new THREE.BufferGeometry(), ghostMat);
const ghostFill = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ color: 0x6fb3ff, transparent: true, opacity: 0.18, depthWrite: false }),
);
ghostFill.rotation.x = -Math.PI / 2;
ghostRobot.add(ghostOutline, ghostArrow, ghostFill);
ghostRobot.visible = false;
scene.add(ghostRobot);
const ghostBox = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x6fb3ff, transparent: true, opacity: 0.28, depthWrite: false }),
);
ghostBox.visible = false;
scene.add(ghostBox);
const setGhostShape = (m: RobotMeta) => {
  const b = m.world.body;
  const z = 0.25;
  ghostOutline.geometry.dispose();
  ghostOutline.geometry = new THREE.BufferGeometry().setFromPoints([
    P(b.front_cm, b.half_width_cm, z),
    P(b.front_cm, -b.half_width_cm, z),
    P(-b.back_cm, -b.half_width_cm, z),
    P(-b.back_cm, b.half_width_cm, z),
  ]);
  ghostArrow.geometry.dispose();
  ghostArrow.geometry = new THREE.BufferGeometry().setFromPoints([
    P(0, 0, z),
    P(b.front_cm + 8, 0, z),
    P(b.front_cm + 5, 2.5, z),
    P(b.front_cm + 8, 0, z),
    P(b.front_cm + 5, -2.5, z),
  ]);
  ghostFill.scale.set(b.front_cm + b.back_cm, 2 * b.half_width_cm, 1);
  ghostFill.position.copy(P((b.front_cm - b.back_cm) / 2, 0, 0.2));
};
for (const o of [coneGroup, trail, ghostRobot, ghostBox]) o.traverse((c) => c.layers.set(HELPERS));

// ---------------------------------------------------------------- the socket
let ws: WebSocket | null = null;
let req = 0;
const pending = new Map<number, string>();
let retryMs = 800;
let offlineTimer: ReturnType<typeof setTimeout> | null = null;
function send(m: PageMessage, what: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return hud.toast("Sin conexión con spinecord");
  pending.set(m.req, what);
  ws.send(JSON.stringify(m));
}
const nextReq = () => ++req;
function connect(): void {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    retryMs = 800;
    if (offlineTimer) clearTimeout(offlineTimer);
    $("offline").hidden = true;
    hud.chip("chip-ws", ["Conectado", "ok"]);
  };
  ws.onmessage = (ev) => receive(JSON.parse(String(ev.data)) as ServerMessage);
  ws.onclose = () => {
    hud.chip("chip-ws", ["Reconectando…", "warn"]);
    offlineTimer ??= setTimeout(() => ($("offline").hidden = false), 1500);
    setTimeout(connect, retryMs);
    retryMs = Math.min(5000, retryMs * 1.6);
  };
}

function receive(m: ServerMessage): void {
  switch (m.t) {
    case "hello": {
      robots = m.robots;
      interval = 1000 / m.rate_hz;
      const sel = $<HTMLSelectElement>("robot");
      sel.innerHTML = robots.map((r) => `<option value="${r.id}">${r.id}</option>`).join("");
      sel.hidden = robots.length < 2;
      const keepId = focus && robots.some((r) => r.id === focus!.id) ? focus.id : robots[0]?.id;
      sel.value = keepId ?? "";
      hud.callsReset();
      for (const c of m.calls) hud.call(c);
      setFocus(keepId ?? null);
      break;
    }
    case "robot": {
      robots = robots.map((r) => (r.id === m.robot.id ? m.robot : r));
      if (focus?.id === m.robot.id) setFocus(m.robot.id);
      break;
    }
    case "boxes":
      if (focus?.id === m.id && arena) {
        focus.world.boxes = m.boxes;
        arena.setBoxes(m.boxes);
      }
      break;
    case "state": {
      const st = m.robots.find((r) => r.id === focus?.id);
      if (st) onState(st);
      break;
    }
    case "tone":
      if (m.id === focus?.id) {
        sound.tone(m.hz, m.ms, m.volume);
        say(`♪ ${m.hz} Hz · ${m.ms} ms`, 1200, true);
      }
      break;
    case "speak":
      if (m.id === focus?.id) {
        sound.speak(m.text);
        say(`🗣 ${m.text}`, Math.max(2600, m.text.length * 75));
      }
      break;
    case "call_start":
    case "call_end":
      hud.call(m);
      break;
    case "reply": {
      const what = pending.get(m.req);
      pending.delete(m.req);
      if (!m.ok) hud.toast(`${what ?? "No se pudo"}: ${m.error ?? "error"}`);
      break;
    }
  }
}

// ---------------------------------------------------------------- focus: build the world and the robot
let firstView = true;
function setFocus(id: string | null): void {
  focus = robots.find((r) => r.id === id) ?? null;
  if (arena) {
    scene.remove(arena.group);
    arena.dispose();
    arena = null;
  }
  if (model) {
    robotRoot.remove(model.group);
    model.dispose();
    model = null;
  }
  cur = null;
  from = shown = null;
  trailReset();
  if (!focus) return;
  const look = lookOf(focus);
  model = buildRobot(focus, look);
  robotRoot.add(model.group);
  arena = buildArena(focus.world, model.height, renderer.capabilities.getMaxAnisotropy());
  scene.add(arena.group);
  setGhostShape(focus);
  coneGroup.visible = model.rayOrigin !== null && $<HTMLInputElement>("opt-cone").checked;
  roles = {};
  if (focus.drivetrain) {
    const what = look.drive === "tracks" ? "oruga" : "rueda";
    roles[focus.drivetrain.left] = `${what} izq.`;
    roles[focus.drivetrain.right] = `${what} der.`;
  }
  $("pip").hidden = !$<HTMLInputElement>("opt-pip").checked;
  // light and fog to the size of the arena
  const w = focus.world,
    size = Math.max(w.width, w.height);
  const centre = toScene(w.width / 2, w.height / 2);
  sun.position.set(centre.x - size * 0.35, size * 1.2, centre.z + size * 0.55);
  sun.target.position.copy(centre);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -size * 0.75;
  sc.right = sc.top = size * 0.75;
  sc.near = 1;
  sc.far = size * 4;
  sc.updateProjectionMatrix();
  (scene.fog as THREE.Fog).near = size * 1.5;
  (scene.fog as THREE.Fog).far = size * 4.5;
  controls.maxDistance = size * 3;
  if (firstView) {
    firstView = false;
    const s = toScene(w.start.x, w.start.y);
    controls.target.copy(s);
    const h = w.start.heading_deg * DEG;
    // behind the robot and to its right, close enough to see its parts; a robot whose phone looks ahead is first
    // seen from the front, where its face reads
    const az = (look.phone && Math.cos(look.phone.yaw * DEG) > 0.5 ? -135 : -32) * DEG;
    const a = h + Math.PI - az,
      d = 58,
      el = 38 * DEG;
    camera.position.set(s.x + Math.cos(a) * Math.cos(el) * d, Math.sin(el) * d, s.z - Math.sin(a) * Math.cos(el) * d);
    placeCamera(camera, controls.target, h);
    controls.update();
  }
}

function onState(st: RobotState): void {
  const now = performance.now();
  const tachos: Record<string, number> = {};
  for (const mo of st.motors) tachos[mo.port] = mo.tacho_deg;
  const next: Shown = { x: st.pose.x, y: st.pose.y, th: st.pose.heading_deg * DEG, tachos };
  // a jump (picked up, reset, a new world) is shown at once, not glided over
  const jump = !shown || Math.hypot(shown.x - next.x, shown.y - next.y) > 15 || Math.abs(shown.th - next.th) > 0.8;
  from = jump ? next : { ...shown!, tachos: { ...shown!.tachos } };
  if (jump) {
    shown = next;
    if (cur && trailN > 0) trailReset();
  }
  cur = st;
  curAt = now;
  stateForHud = st;
}

function glide(now: number): Shown | null {
  if (!cur || !from) return null;
  const a = Math.min(1, Math.max(0, (now - curAt) / interval));
  const to = cur;
  let dth = to.pose.heading_deg * DEG - from.th;
  dth = Math.atan2(Math.sin(dth), Math.cos(dth));
  const tachos: Record<string, number> = {};
  for (const mo of to.motors) {
    const f = from.tachos[mo.port] ?? mo.tacho_deg;
    tachos[mo.port] = f + (mo.tacho_deg - f) * a;
  }
  shown = {
    x: from.x + (to.pose.x - from.x) * a,
    y: from.y + (to.pose.y - from.y) * a,
    th: from.th + dth * a,
    tachos,
  };
  return shown;
}

// ---------------------------------------------------------------- the panels, ten times a second
let stateForHud: RobotState | null = null;
/** When the robot was last seen pushing against something: the chip stays a moment after. */
let pushedAt = -Infinity;
setInterval(() => {
  const st = stateForHud;
  if (!st) return;
  stateForHud = null;
  hud.chip("chip-link", hud.LINK[st.link] ?? [st.link, ""]);
  hud.chip("chip-activity", hud.ACTIVITY[st.activity] ?? [st.activity, ""]);
  if (st.motors.some((m) => m.blocked) || (st.stalled && st.activity !== "idle")) pushedAt = performance.now();
  $("chip-stall").hidden = performance.now() - pushedAt > 3000;
  const heading = ((Math.round(st.pose.heading_deg) % 360) + 360) % 360;
  $("pose").textContent =
    `x ${st.pose.x.toFixed(1)} · y ${st.pose.y.toFixed(1)} cm · θ ${heading}° · t ${(st.t_ms / 1000).toFixed(1)} s`;
  hud.ports(st, roles);
}, 100);

// ---------------------------------------------------------------- speech bubble
let bubbleUntil = 0;
let bubbleIsTone = false;
function say(text: string, ms: number, tone = false): void {
  if (tone && !bubbleIsTone && performance.now() < bubbleUntil) return; // a phrase on screen wins over a beep
  const el = $("bubble");
  el.textContent = text;
  el.hidden = false;
  bubbleIsTone = tone;
  bubbleUntil = performance.now() + ms;
}

// ---------------------------------------------------------------- the hand
type Mode = "look" | "carry" | "box" | "remove";
let mode: Mode = "look";
type Drag =
  | { kind: "robot"; dx: number; dy: number; x: number; y: number; th: number }
  | { kind: "place"; x0: number; y0: number; th: number }
  | { kind: "box"; x0: number; y0: number; x: number; y: number };
let drag: Drag | null = null;
const raycaster = new THREE.Raycaster();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ndc = new THREE.Vector2();
const pointerAt = (e: PointerEvent) => {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
};
/** The world point (cm) under the pointer, on the floor, kept inside the arena. */
const floorAt = (e: PointerEvent): { x: number; y: number } | null => {
  pointerAt(e);
  const p = raycaster.ray.intersectPlane(floorPlane, new THREE.Vector3());
  if (!p || !focus) return null;
  const { width, height } = focus.world;
  return { x: Math.min(width, Math.max(0, p.x)), y: Math.min(height, Math.max(0, -p.z)) };
};
const onRobot = (e: PointerEvent): boolean => {
  if (!model) return false;
  pointerAt(e);
  return raycaster.intersectObject(model.group, true).length > 0;
};
const boxUnder = (e: PointerEvent): number | null => {
  if (!arena) return null;
  pointerAt(e);
  const hit = raycaster.intersectObjects(arena.boxes, false)[0];
  return hit ? (hit.object.userData.index as number) : null;
};
const showGhost = (x: number, y: number, th: number) => {
  ghostRobot.visible = true;
  ghostRobot.position.copy(toScene(x, y));
  ghostRobot.rotation.y = th;
};
const HINTS: Record<Mode, string> = {
  look: "",
  carry: "Pulsa donde quieres el robot y arrastra hacia donde debe mirar · Q / E lo giran · Esc sale",
  box: "Arrastra un rectángulo en el suelo para poner una caja · un clic pone una de 20 × 20 cm · Esc sale",
  remove: "Haz clic en una caja para quitarla · Esc sale",
};
function setMode(m: Mode): void {
  mode = m;
  drag = null;
  ghostRobot.visible = ghostBox.visible = false;
  arena?.highlight(null);
  for (const b of document.querySelectorAll<HTMLButtonElement>("#modes button"))
    b.classList.toggle("on", b.dataset.mode === m);
  canvas.className = m === "carry" || m === "box" ? "place" : "";
  hud.hint(camMode === "eye" && m !== "look" ? "Cambia a la cámara Libre o Seguir para usar la mano" : HINTS[m]);
}

// registered before OrbitControls: a drag the hand takes turns the controls off before they see the press
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !focus || !cur || camMode === "eye") return;
  if (mode === "remove") {
    const i = boxUnder(e);
    if (i !== null) {
      controls.enabled = false;
      e.stopImmediatePropagation();
      send({ t: "box_remove", req: nextReq(), id: focus.id, index: i }, "No se pudo quitar la caja");
      drag = null;
    }
    return;
  }
  const p = floorAt(e);
  if (!p) return;
  if (mode === "look") {
    if (!onRobot(e)) return;
    const s = shown ?? { x: cur.pose.x, y: cur.pose.y, th: cur.pose.heading_deg * DEG };
    drag = { kind: "robot", dx: s.x - p.x, dy: s.y - p.y, x: s.x, y: s.y, th: s.th };
    canvas.className = "grabbing";
    showGhost(s.x, s.y, s.th);
  } else if (mode === "carry") {
    drag = { kind: "place", x0: p.x, y0: p.y, th: shown?.th ?? cur.pose.heading_deg * DEG };
    showGhost(p.x, p.y, drag.th);
  } else if (mode === "box") {
    drag = { kind: "box", x0: p.x, y0: p.y, x: p.x, y: p.y };
  }
  if (drag) {
    // the hand has it: the camera must not turn with this drag
    controls.enabled = false;
    e.stopImmediatePropagation();
    canvas.setPointerCapture(e.pointerId);
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) {
    if (mode === "remove") arena?.highlight(boxUnder(e));
    else if (mode === "look" && camMode !== "eye") canvas.className = onRobot(e) ? "grab" : "";
    return;
  }
  const p = floorAt(e);
  if (!p) return;
  if (drag.kind === "robot") {
    drag.x = Math.min(focus!.world.width, Math.max(0, p.x + drag.dx));
    drag.y = Math.min(focus!.world.height, Math.max(0, p.y + drag.dy));
    showGhost(drag.x, drag.y, drag.th);
  } else if (drag.kind === "place") {
    const dx = p.x - drag.x0,
      dy = p.y - drag.y0;
    if (Math.hypot(dx, dy) > 3) drag.th = Math.atan2(dy, dx);
    showGhost(drag.x0, drag.y0, drag.th);
  } else {
    drag.x = p.x;
    drag.y = p.y;
    const r = boxRect(drag);
    ghostBox.visible = true;
    ghostBox.scale.set(r.w, 14, r.h);
    ghostBox.position.copy(toScene(r.x + r.w / 2, r.y + r.h / 2, 7));
  }
});
const boxRect = (d: { x0: number; y0: number; x: number; y: number }): Box => {
  if (Math.hypot(d.x - d.x0, d.y - d.y0) < 3) return { x: d.x0 - 10, y: d.y0 - 10, w: 20, h: 20 };
  const x = Math.min(d.x0, d.x),
    y = Math.min(d.y0, d.y);
  return { x, y, w: Math.max(2, Math.abs(d.x - d.x0)), h: Math.max(2, Math.abs(d.y - d.y0)) };
};
const endDrag = (e: PointerEvent, cancel = false) => {
  controls.enabled = camMode !== "eye";
  const d = drag;
  drag = null;
  ghostRobot.visible = ghostBox.visible = false;
  if (mode === "look") canvas.className = "";
  if (!d || !focus || cancel) return;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if (d.kind === "robot")
    send({ t: "carry", req: nextReq(), id: focus.id, x: d.x, y: d.y, heading_deg: d.th / DEG }, "No cabe ahí");
  else if (d.kind === "place")
    send({ t: "carry", req: nextReq(), id: focus.id, x: d.x0, y: d.y0, heading_deg: d.th / DEG }, "No cabe ahí");
  else {
    const r = boxRect(d);
    send({ t: "box_add", req: nextReq(), id: focus.id, ...r }, "No se pudo poner la caja");
  }
};
canvas.addEventListener("pointerup", (e) => endDrag(e));
canvas.addEventListener("pointercancel", (e) => endDrag(e, true));

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === "Escape") {
    drag = null;
    controls.enabled = camMode !== "eye";
    setMode("look");
  } else if ((e.key === "q" || e.key === "e") && focus && cur && !drag) {
    const s = shown ?? { x: cur.pose.x, y: cur.pose.y, th: cur.pose.heading_deg * DEG };
    const turn = e.key === "q" ? 15 : -15;
    send(
      { t: "carry", req: nextReq(), id: focus.id, x: s.x, y: s.y, heading_deg: s.th / DEG + turn },
      "No se pudo girar",
    );
  } else if (["1", "2", "3", "4"].includes(e.key))
    setMode((["look", "carry", "box", "remove"] as const)[Number(e.key) - 1]!);
});

// ---------------------------------------------------------------- the controls of the page
for (const b of document.querySelectorAll<HTMLButtonElement>("#modes button"))
  b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
$("restore").addEventListener("click", () => {
  if (focus) send({ t: "restore", req: nextReq(), id: focus.id }, "No se pudo restaurar");
  trailReset();
});
$<HTMLSelectElement>("robot").addEventListener("change", (e) => setFocus((e.target as HTMLSelectElement).value));
$<HTMLInputElement>("opt-cone").addEventListener("change", (e) => {
  coneGroup.visible = (e.target as HTMLInputElement).checked && model?.rayOrigin != null;
});
$<HTMLInputElement>("opt-trail").addEventListener(
  "change",
  (e) => (trail.visible = (e.target as HTMLInputElement).checked),
);
$<HTMLInputElement>("opt-pip").addEventListener("change", (e) => {
  $("pip").hidden = !(e.target as HTMLInputElement).checked || camMode === "eye";
});
$<HTMLInputElement>("opt-sound").addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  sound.setEnabled(on);
  if (on) hud.toast("Sonido activado: tonos del ladrillo y voz del altavoz simulado", true);
});
for (const b of document.querySelectorAll<HTMLButtonElement>("#pad button")) {
  const btn = Number(b.dataset.btn);
  let down = false;
  const press = (d: boolean) => {
    if (!focus || down === d) return;
    down = d;
    send({ t: "button", req: nextReq(), id: focus.id, button: btn, down: d }, "Botón");
  };
  b.addEventListener("pointerdown", (e) => {
    try {
      b.setPointerCapture(e.pointerId); // held while the pointer is down, even off the button
    } catch {
      // a pointer the browser does not know (a synthetic event): pressed until pointerup all the same
    }
    press(true);
  });
  b.addEventListener("pointerup", () => press(false));
  b.addEventListener("pointercancel", () => press(false));
  b.addEventListener("lostpointercapture", () => press(false));
}

// ---------------------------------------------------------------- cameras
type Cam = "free" | "follow" | "eye";
let camMode: Cam = "follow";
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2 - 0.04;
controls.minDistance = 12;
controls.target.set(60, 0, -60);
camera.position.set(-20, 90, 40);
let saved: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
for (const b of document.querySelectorAll<HTMLButtonElement>("#cams button"))
  b.addEventListener("click", () => {
    const next = b.dataset.cam as Cam;
    if (next === camMode) return;
    if (next === "eye") saved = { pos: camera.position.clone(), target: controls.target.clone() };
    else if (camMode === "eye" && saved) {
      camera.position.copy(saved.pos);
      controls.target.copy(saved.target);
    }
    camMode = next;
    controls.enabled = next !== "eye";
    for (const x of document.querySelectorAll<HTMLButtonElement>("#cams button"))
      x.classList.toggle("on", x.dataset.cam === next);
    $("pip").hidden = next === "eye" || !$<HTMLInputElement>("opt-pip").checked;
    setMode(mode);
  });
let lastFollow: THREE.Vector3 | null = null;

// ---------------------------------------------------------------- every frame
const tmpA = new THREE.Vector3(),
  tmpB = new THREE.Vector3();
function resize(): void {
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  const c = renderer.domElement;
  if (c.width !== Math.floor(w * renderer.getPixelRatio()) || c.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
const rayColour = new THREE.Color();
function updateCone(st: RobotState): void {
  if (!model?.rayOrigin || !coneGroup.visible) return;
  const o = model.rayOrigin;
  const a = 12 * DEG;
  const dist = st.sensors.find((s) => s.kind === "ultrasonic" || s.kind === "ir");
  const reading = dist?.values[0];
  const near = typeof reading === "number" && dist?.kind === "ultrasonic" ? reading : Math.min(...st.rays_cm);
  rayColour.setHSL(Math.min(0.36, Math.max(0, (near - 5) / 120) * 0.36), 0.85, 0.5);
  coneMat.color.copy(rayColour);
  (rays.material as THREE.LineBasicMaterial).color.copy(rayColour);
  conePos.set([o.x, o.y, o.z], 0);
  [-a, 0, a].forEach((off, i) => {
    const L = Math.min(255, st.rays_cm[i]!);
    const x = o.x + Math.cos(off) * L,
      z = o.z - Math.sin(off) * L;
    conePos.set([x, o.y, z], (i + 1) * 3);
    rayPos.set([o.x, o.y, o.z, x, o.y, z], i * 6);
    hits[i]!.position.set(x, o.y, z);
    hits[i]!.visible = st.rays_cm[i]! <= 250;
    (hits[i]!.material as THREE.MeshBasicMaterial).color.copy(rayColour);
  });
  coneGeo.attributes.position!.needsUpdate = true;
  rayGeo.attributes.position!.needsUpdate = true;
  coneGeo.computeBoundingSphere();
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  resize();
  const t = now / 1000;
  const s = glide(now);
  if (s && model && cur) {
    robotRoot.position.copy(toScene(s.x, s.y));
    robotRoot.rotation.y = s.th;
    robotRoot.visible = true;
    model.update(cur, s.tachos, t);
    updateCone(cur);
    if (trail.visible) trailAdd(s.x, s.y);
    hud.led(cur.led, t);
  } else robotRoot.visible = false;

  if (s && camMode === "follow") {
    const p = toScene(s.x, s.y, 4);
    if (lastFollow) {
      tmpA.subVectors(p, lastFollow);
      camera.position.add(tmpA);
      controls.target.add(tmpA);
    } else controls.target.copy(p);
    lastFollow = p;
  } else lastFollow = null;

  // the robot's camera
  if (model && s) {
    robotRoot.updateMatrixWorld();
    eyeCam.position.copy(tmpA.copy(model.eye.pos).applyMatrix4(robotRoot.matrixWorld));
    eyeCam.lookAt(tmpB.copy(model.eye.look).applyMatrix4(robotRoot.matrixWorld));
  }
  if (camMode === "eye" && model && s) {
    camera.layers.disable(HELPERS); // the robot's camera sees what the robot sees, never the helpers
    camera.position.copy(eyeCam.position);
    camera.quaternion.copy(eyeCam.quaternion);
  } else {
    camera.layers.enable(HELPERS);
    controls.update();
  }

  // the bubble over the robot
  const bubble = $("bubble");
  if (!bubble.hidden) {
    if (now > bubbleUntil || !model || !s) bubble.hidden = true;
    else {
      tmpA
        .set(0, model.height + 4, 0)
        .applyMatrix4(robotRoot.matrixWorld)
        .project(camera);
      const r = canvas.getBoundingClientRect();
      bubble.style.left = `${r.left + ((tmpA.x + 1) / 2) * r.width}px`;
      bubble.style.top = `${r.top + ((1 - tmpA.y) / 2) * r.height}px`;
    }
  }

  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);
  const pip = $("pip");
  if (!pip.hidden && model && s) {
    const r = pip.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    const x = r.left - c.left,
      y = c.bottom - r.bottom;
    eyeCam.aspect = r.width / r.height;
    eyeCam.updateProjectionMatrix();
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, r.width, r.height);
    renderer.setViewport(x, y, r.width, r.height);
    // the phone's camera does not see the robot it stands on, and skipping the body halves this pass's cost
    const shown = model.group.visible;
    model.group.visible = false;
    renderer.render(scene, eyeCam);
    model.group.visible = shown;
    renderer.setScissorTest(false);
  }
  frameStats(renderer, now);
}

setMode("look");
applyLink();
connect();
requestAnimationFrame(frame);
