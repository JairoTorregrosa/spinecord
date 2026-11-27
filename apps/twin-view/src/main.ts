// The 3D view of the twins: one socket to the spinecord process (apps/local --view), the scene, and the hand of
// the person watching. The twin runs in the process; this page only shows it and asks it for what a person
// does to a robot on the floor (pick it up, set boxes down, press a button).
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { buildArena, toScene, type Arena } from "./arena";
import { Sound } from "./audio";
import { Cameras, CAMS, type Cam } from "./camera";
import { Hand, MODES, heading, type Mode } from "./hand";
import * as hud from "./hud";
import { Link, type LinkState } from "./link";
import { lookOf } from "./look";
import type { RobotMeta, RobotState, ServerMessage } from "./messages";
import { buildRobot, type RobotModel } from "./model";

const $ = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`the page has no #${id}`);
  return e as T;
};
const DEG = Math.PI / 180;
const HELPERS = 1; // layer of what only the person sees: rays, trail, ghosts

// ---------------------------------------------------------------- renderer, scene, lights
const canvas = $<HTMLCanvasElement>("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);
scene.fog = new THREE.Fog(0x14171c, 500, 2000);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;
scene.add(new THREE.HemisphereLight(0xe2ebff, 0x3b322a, 0.85));
const sun = new THREE.DirectionalLight(0xfff3e2, 2.3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.03;
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

for (const o of [coneGroup, trail]) o.traverse((c) => c.layers.set(HELPERS));
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// ---------------------------------------------------------------- the socket
const link = new Link(`ws://${location.host}/ws`, (m) => receive(m), linkChanged);
let offlineTimer: ReturnType<typeof setTimeout> | null = null;
let offlineClock: ReturnType<typeof setInterval> | null = null;
function linkChanged(s: LinkState): void {
  document.body.classList.toggle("stale", s !== "open");
  if (s === "open") {
    if (offlineTimer) clearTimeout(offlineTimer);
    if (offlineClock) clearInterval(offlineClock);
    offlineTimer = offlineClock = null;
    $("offline").hidden = true;
    hud.chip("chip-ws", ["Conectado", "ok"]);
    return;
  }
  hud.chip("chip-ws", ["Reconectando…", "warn"]);
  // a blink of the socket is not worth a curtain; a real loss is, with how long it has lasted
  offlineTimer ??= setTimeout(() => {
    $("offline").hidden = false;
    const tick = () =>
      ($("offline-since").textContent =
        `Sin datos desde hace ${Math.round((performance.now() - link.closedAt) / 1000)} s · reintentando…`);
    tick();
    offlineClock = setInterval(tick, 1000);
  }, 1500);
}

function receive(m: ServerMessage): void {
  switch (m.t) {
    case "hello": {
      robots = m.robots;
      interval = 1000 / m.rate_hz;
      const sel = $<HTMLSelectElement>("robot");
      sel.replaceChildren(...robots.map((r) => new Option(r.id, r.id)));
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
    case "boxes": {
      const r = robots.find((x) => x.id === m.id);
      if (r) r.world.boxes = m.boxes;
      if (focus?.id === m.id && arena) arena.setBoxes(m.boxes);
      break;
    }
    case "state": {
      const st = m.robots.find((r) => r.id === focus?.id);
      if (st) onState(st);
      break;
    }
    case "tone":
      if (m.id === focus?.id) {
        sound.tone(m.hz, m.ms, m.volume);
        say(`♪ ${m.hz} Hz · ${m.ms} ms`, 1200, true);
        missedSound();
      }
      break;
    case "speak":
      if (m.id === focus?.id) {
        sound.speak(m.text);
        say(`🗣 ${m.text}`, Math.max(2600, m.text.length * 75));
        missedSound();
      }
      break;
    case "call_start":
    case "call_end":
      hud.call(m);
      break;
  }
}

// ---------------------------------------------------------------- focus: build the world and the robot
/** The robot and world the camera last framed: another one is framed afresh, the same one keeps the view. */
let framed = "";
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
  hand.reset(focus);
  showConeOption();
  if (!focus) return;
  const look = lookOf(focus);
  model = buildRobot(focus, look);
  robotRoot.add(model.group);
  arena = buildArena(focus.world, model.height);
  scene.add(arena.group);
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
  (scene.fog as THREE.Fog).near = size * 3;
  (scene.fog as THREE.Fog).far = size * 9;
  const key = `${focus.id}\n${w.name}`;
  cams.fitArena(w, key !== framed);
  framed = key;
}

/** The cone option names the distance sensor this robot has, and is not offered when it has none. */
function showConeOption(): void {
  const kind = focus ? Object.values(focus.ports.sensors).find((k) => k === "ultrasonic" || k === "ir") : undefined;
  $("opt-cone-row").hidden = kind === undefined;
  $("opt-cone-label").textContent = kind ? hud.CONE[kind]! : "";
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
  $("pose").textContent =
    `x ${st.pose.x.toFixed(1)} · y ${st.pose.y.toFixed(1)} cm · θ ${heading(st.pose.heading_deg).toFixed(0)}°`;
  $("clock").textContent = `t ${(st.t_ms / 1000).toFixed(1)} s`;
  hud.ports(st, roles);
}, 100);
setInterval(() => {
  hud.callsTick();
  const p = hand.pointer;
  $("pointer").textContent = p ? `x ${p.x.toFixed(1)} · y ${p.y.toFixed(1)} cm` : "—";
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

// ---------------------------------------------------------------- the camera and the hand
const cams = new Cameras(
  camera,
  canvas,
  (m) => {
    for (const b of document.querySelectorAll<HTMLButtonElement>("#cams button")) {
      const on = b.dataset.cam === m;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
    $("pip").hidden = m === "eye" || !$<HTMLInputElement>("opt-pip").checked;
    canvas.dataset.cam = m;
    hand.refreshHint();
  },
  freeArea,
);
/** The canvas left uncovered by the panels, for the top view. */
function freeArea(): { left: number; top: number; right: number; bottom: number } {
  const r = (id: string) => $(id).getBoundingClientRect();
  const c = canvas.getBoundingClientRect();
  const hint = $("hint");
  const top = Math.max(r("bar").bottom, hint.hidden ? 0 : hint.getBoundingClientRect().bottom) + 8;
  const left = $("tools").classList.contains("folded") ? 12 : r("tools").right + 8;
  const right = $("brick").classList.contains("folded") ? c.width - 12 : r("brick").left - 8;
  return { left: left - c.left, top: top - c.top, right: right - c.left, bottom: r("callpanel").top - 8 - c.top };
}
const shownPose = () => shown ?? (cur ? { x: cur.pose.x, y: cur.pose.y, th: cur.pose.heading_deg * DEG } : null);
const hand = new Hand({
  canvas,
  camera,
  scene,
  cams,
  link,
  focus: () => focus,
  pose: shownPose,
  arena: () => arena,
  robot: () => model?.group ?? null,
  helpers: HELPERS,
});
/** Puts the view in camera mode `m`: the buttons, the keys, and a deep link use this. */
export function setCam(m: Cam): void {
  cams.set(m);
}

// ---------------------------------------------------------------- the controls of the page
for (const b of document.querySelectorAll<HTMLButtonElement>("#modes button"))
  b.addEventListener("click", () => hand.setMode(b.dataset.mode as Mode));
for (const b of document.querySelectorAll<HTMLButtonElement>("#cams button"))
  b.addEventListener("click", () => setCam(b.dataset.cam as Cam));
$("cam-reset").addEventListener("click", () => cams.reset(shownPose()));
$("restore").addEventListener("click", () => {
  if (!focus) return;
  const id = focus.id;
  void link.request({ t: "restore", id }).then((r) => {
    if (!r.ok) return hud.toast(`${hud.REFUSAL[r.code]}${r.code === "internal" ? `: ${r.error}` : ""}`);
    if (focus?.id === id) trailReset();
    hud.toast("Mundo restaurado: sus cajas de origen y el robot en la salida (giroscopio y odometría a cero)", "info");
  });
});
$("trail-clear").addEventListener("click", () => trailReset());
$<HTMLSelectElement>("robot").addEventListener("change", (e) => setFocus((e.target as HTMLSelectElement).value));
$<HTMLInputElement>("opt-cone").addEventListener("change", (e) => {
  coneGroup.visible = (e.target as HTMLInputElement).checked && model?.rayOrigin != null;
});
$<HTMLInputElement>("opt-trail").addEventListener(
  "change",
  (e) => (trail.visible = (e.target as HTMLInputElement).checked),
);
$<HTMLInputElement>("opt-pip").addEventListener("change", (e) => {
  $("pip").hidden = !(e.target as HTMLInputElement).checked || cams.mode === "eye";
});

// sound: off until the person's click lets the browser play
const soundBtn = $<HTMLButtonElement>("sound");
let soundNoted = false;
async function toggleSound(): Promise<void> {
  const want = !sound.enabled;
  const playing = await sound.setEnabled(want);
  soundBtn.setAttribute("aria-pressed", String(playing));
  soundBtn.classList.toggle("on", playing);
  soundBtn.classList.remove("missed");
  soundBtn.textContent = playing ? "🔊 Sonido" : "🔇 Sonido";
  if (want && !playing) hud.toast("El navegador no deja sonar la página: pulsa otra vez el botón de sonido");
  else if (playing) hud.toast("Sonido activado: tonos del ladrillo y voz del altavoz simulado", "info");
}
soundBtn.addEventListener("click", () => void toggleSound());
/** The robot made a sound the person did not hear: the button says so, and once a note explains it. */
function missedSound(): void {
  if (sound.enabled) return;
  soundBtn.classList.add("missed");
  if (soundNoted) return;
  soundNoted = true;
  hud.toast("El robot está sonando: pulsa 🔇 Sonido (o la tecla M) para oírlo", "info");
}

for (const b of document.querySelectorAll<HTMLButtonElement>("#pad button")) {
  const btn = Number(b.dataset.btn);
  let down = false;
  const press = (d: boolean) => {
    if (!focus || down === d) return;
    down = d;
    void link.request({ t: "button", id: focus.id, button: btn, down: d }).then((r) => {
      if (!r.ok && d) hud.toast(`Botón: ${hud.REFUSAL[r.code]}`);
    });
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
  // the keyboard too: Space or Enter on a focused button holds it while the key is down
  b.addEventListener("keydown", (e) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      press(true);
    }
  });
  b.addEventListener("keyup", (e) => {
    if (e.key === " " || e.key === "Enter") press(false);
  });
  b.addEventListener("blur", () => press(false));
}

// panels fold away to give the scene room; the choice is kept for the next visit
const narrow = matchMedia("(max-width: 760px)");
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-fold]")) {
  const panel = $(b.dataset.fold!);
  const key = `twin-view:fold:${b.dataset.fold}`;
  const set = (folded: boolean) => {
    panel.classList.toggle("folded", folded);
    b.setAttribute("aria-expanded", String(!folded));
    try {
      localStorage.setItem(key, folded ? "1" : "0");
    } catch {
      // storage blocked: the fold works, it is only not remembered
    }
  };
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(key);
  } catch {
    // see above
  }
  set(stored === null ? narrow.matches : stored === "1");
  b.addEventListener("click", () => set(!panel.classList.contains("folded")));
  // a window made narrow folds the side panels, so they do not cover the robot; widened, they open again
  if (b.dataset.fold !== "callpanel") narrow.addEventListener("change", () => set(narrow.matches));
}

const help = $("help");
const showHelp = (on: boolean) => {
  help.hidden = !on;
  if (on) $("help-close").focus();
};
$("help-open").addEventListener("click", () => showHelp(help.hidden === true));
$("help-close").addEventListener("click", () => showHelp(false));
help.addEventListener("click", (e) => {
  if (e.target === help) showHelp(false);
});

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
  const k = e.key.toLowerCase();
  if (k === "escape") {
    if (!help.hidden) return showHelp(false);
    return hand.escape();
  }
  if (t instanceof HTMLButtonElement && (k === " " || k === "enter")) return; // the button's own
  if (k === "?" || k === "h") showHelp(help.hidden === true);
  else if (k === "q" || k === "e") hand.turnKey(k === "q" ? 1 : -1);
  else if (k >= "1" && k <= "5") hand.setMode(MODES[Number(k) - 1]!);
  else if (k === "c") setCam(CAMS[(CAMS.indexOf(cams.mode) + 1) % CAMS.length]!);
  else if (k === "0" || k === "home") cams.reset(shownPose());
  else if (k === "m") void toggleSound();
  else return;
  e.preventDefault();
});
hud.callsInit();
// the panels start below the top bar, whose height grows when a narrow window wraps it
new ResizeObserver(() => {
  const b = $("bar").getBoundingClientRect();
  document.documentElement.style.setProperty("--top", `${Math.round(b.bottom + 12)}px`);
}).observe($("bar"));

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
    hud.led(cur.led, t, reducedMotion.matches);
  } else robotRoot.visible = false;

  // the robot's camera
  if (model && s) {
    robotRoot.updateMatrixWorld();
    eyeCam.position.copy(tmpA.copy(model.eye.pos).applyMatrix4(robotRoot.matrixWorld));
    eyeCam.lookAt(tmpB.copy(model.eye.look).applyMatrix4(robotRoot.matrixWorld));
  }
  cams.update(s, model && s ? eyeCam : null);
  hand.frame();

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
    renderer.render(scene, eyeCam);
    renderer.setScissorTest(false);
  }
}

hand.setMode("look");
requestAnimationFrame(frame);
