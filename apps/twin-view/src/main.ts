// The 3D view of the twins: one socket to the spinecord process (apps/local --view), the scene, and the hand of
// the person watching. The twin runs in the process; this page only shows it and asks it for what a person
// does to a robot on the floor (pick it up, set boxes down, press a button).
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { buildArena, toScene, type Arena } from "./arena";
import { applyLink, frameStats, placeCamera } from "./deeplink";
import { Sound } from "./audio";
import { Cameras, CAMS, type Cam } from "./camera";
import { ChatPanel } from "./chat";
import { Hand, MODES, heading, type Mode } from "./hand";
import * as hud from "./hud";
import { draftLines } from "./draft";
import { LOST_GRACE_MS, hideNo3d, showNo3d } from "./no3d";
import { SensorRayView } from "./rays";
import { Stillness } from "./still";
import { Link, type LinkState } from "./link";
import { lookOf } from "./look";
import { restoredText } from "./restore";
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
/**
 * The renderer, or null when this browser cannot draw in 3D (no WebGL context): the page then says so where the
 * scene would be (src/no3d.ts) and everything else (connection, panels, widgets, calls) goes on without it.
 */
let renderer: THREE.WebGLRenderer | null = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
} catch (e) {
  showNo3d("no_context", (e as Error).message);
}
if (renderer) {
  // 1.5 device pixels per CSS pixel: past that an integrated GPU pays in fill rate for detail nobody sees
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // the sun's shadow does not depend on the camera: drawn when something casting it moved (shadowFrame) and shared
  // by the robot's camera
  renderer.shadowMap.autoUpdate = false;
  // Neutral keeps LEGO's saturated colours and white plastic white, where ACES turns them grey and yellow
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
}
/** Whether a frame would draw anything new (still.ts). */
const still = new Stillness();
// a context the browser takes back (a GPU reset, too many tabs) and does not return within LOST_GRACE_MS
let lostTimer: ReturnType<typeof setTimeout> | null = null;
canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault(); // ask for it back
  lostTimer ??= setTimeout(() => showNo3d("lost", "webglcontextlost without webglcontextrestored"), LOST_GRACE_MS);
});
canvas.addEventListener("webglcontextrestored", () => {
  still.reset();
  if (lostTimer) clearTimeout(lostTimer);
  lostTimer = null;
  hideNo3d();
});
const scene = new THREE.Scene();
// a bright room around the arena, the fog melting the far floor into it
const ROOM = 0xc9c6bf;
scene.background = new THREE.Color(ROOM);
scene.fog = new THREE.Fog(ROOM, 500, 2000);
if (renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
}
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
// The world matrices are brought up to date once a frame, before the shadow's check and the renders.
scene.matrixWorldAutoUpdate = false;
let shadowSig = NaN,
  shadowAt = -Infinity;
/** Draws the sun's shadow again when something casting it, or the sun, moved since it was last drawn: never while
 *  all stands still, and at most every 30 ms while things move (the shadow pass costs as much as the scene's). */
function shadowFrame(now: number): void {
  let sig = sun.position.x + 3 * sun.position.y + 7 * sun.position.z + 11 * sun.shadow.camera.right,
    n = 0;
  scene.traverseVisible((o) => {
    if (!o.castShadow) return;
    n++;
    const e = o.matrixWorld.elements;
    for (let i = 0; i < 16; i++) sig += e[i]! * (i + 1 + (n % 13));
  });
  sig += n * 1e6;
  if (sig === shadowSig || now - shadowAt < 30) return;
  if (renderer) renderer.shadowMap.needsUpdate = true;
  shadowSig = sig;
  shadowAt = now;
}

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
/** --chat: the panel is built only when the process's hello says the chat is on. */
const chat = new ChatPanel({
  send: (m) => link.send(m),
  toast: (text, kind) => hud.toast(text, kind),
  setVoice: (v) => (sound.voice = v),
});

// ---------------------------------------------------------------- the sensors' rays, as the physics casts them
const sensorRays = new SensorRayView();
const coneGroup = sensorRays.group;
robotRoot.add(coneGroup);

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

// ---------------------------------------------------------------- the socket
const link = new Link(`ws://${location.host}/ws`, (m) => receive(m), linkChanged);
let offlineTimer: ReturnType<typeof setTimeout> | null = null;
let offlineClock: ReturnType<typeof setInterval> | null = null;
function linkChanged(s: LinkState): void {
  chat.linkState(s === "open");
  document.body.classList.toggle("stale", s !== "open");
  if (s === "open") {
    if (offlineTimer) clearTimeout(offlineTimer);
    if (offlineClock) clearInterval(offlineClock);
    offlineTimer = offlineClock = null;
    $("offline").hidden = true;
    hud.chip("chip-ws", ["Conectado", "ok"]);
    // back after a loss: the robot may be anywhere now
    if (cams.mode === "follow") cams.frame("ease");
    return;
  }
  // at once: nothing the chips said is known any more; they come back with the first state after the return
  hud.chip("chip-ws", ["Sin conexión · reintentando", "bad"]);
  hud.chip("chip-link", ["—", ""]);
  hud.chip("chip-activity", ["—", ""]);
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
      sel.replaceChildren(...robots.map((r) => new Option(r.name ? `${r.name} · ${r.id}` : r.id, r.id)));
      sel.hidden = robots.length < 2;
      const keepId = focus && robots.some((r) => r.id === focus!.id) ? focus.id : robots[0]?.id;
      sel.value = keepId ?? "";
      hud.callsReset();
      for (const c of m.calls) hud.call(c);
      for (const e of m.events.find((x) => x.id === keepId)?.events ?? []) hud.worldEvent(e);
      chat.hello(m.chat);
      for (const c of m.calls) chat.call(c);
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
      if (focus?.id === m.id && arena) {
        arena.setBoxes(m.boxes);
        hand.boxesChanged();
      }
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
    case "events":
      if (m.id === focus?.id) for (const e of m.events) hud.worldEvent(e);
      break;
    case "call_start":
    case "call_end":
      hud.call(m);
      chat.call(m);
      break;
    case "chat":
    case "chat_user":
    case "chat_delta":
    case "chat_end":
    case "chat_stopped":
    case "chat_refused":
      chat.receive(m);
      break;
  }
}

// ---------------------------------------------------------------- focus: build the world and the robot
/** The robot's name is the page's title, its id beside it; without a name, the page's own title. */
/** The "borrador" chip, only for a twin whose build someone has yet to confirm. */
function showDraft(r: RobotMeta | null): void {
  const lines = r ? draftLines(r) : [];
  $("chip-draft").hidden = lines.length === 0;
  $("draft-items").replaceChildren(
    ...lines.map((l) => {
      const li = document.createElement("li");
      li.textContent = l;
      return li;
    }),
  );
}

function showTitle(r: RobotMeta | null): void {
  showDraft(r);
  const title = $("title");
  if (!r?.name) {
    title.innerHTML = "EV3 <b>gemelo 3D</b>";
    document.title = "EV3 · gemelo 3D";
    return;
  }
  const name = document.createElement("b"),
    id = document.createElement("span");
  name.textContent = r.name;
  id.className = "dim";
  id.textContent = r.id;
  title.replaceChildren(name, " ", id);
  document.title = `${r.name} · gemelo 3D`;
}

/** The robot and world the camera last framed: another one is framed afresh, the same one keeps the view. */
let framed = "";
/** Fog hides where the floor ends at eye level. From straight above the camera stands far off: there it would hide the arena. */
function fitFog(): void {
  if (!focus) return;
  const size = Math.max(focus.world.width, focus.world.height);
  const far = cams.mode === "top" ? 40 : 4.5;
  (scene.fog as THREE.Fog).near = (size * far) / 3;
  (scene.fog as THREE.Fog).far = size * far;
}
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
  showTitle(focus);
  if (!focus) return;
  const look = lookOf(focus);
  model = buildRobot(focus, look);
  robotRoot.add(model.group);
  arena = buildArena(focus.world, model.height, renderer?.capabilities.getMaxAnisotropy() ?? 1);
  scene.add(arena.group);
  coneGroup.visible = hasRays(focus) && $<HTMLInputElement>("opt-cone").checked;
  roles = {};
  // the drive motors say what they turn, as the build has it: tracks, wheels, or nothing (a build without a drive)
  const turns = look.drive === "tracks" ? "oruga" : look.drive === "wheels" ? "rueda" : null;
  if (focus.drivetrain && turns) {
    roles[focus.drivetrain.left] = `${turns} izq.`;
    roles[focus.drivetrain.right] = `${turns} der.`;
  }
  // and the others what they move, as the look builds it
  const MOVES: Record<string, string> = {
    axle: "eje",
    arm: "brazo",
    lift: "elevador",
    turntable: "plataforma",
    gripper: "pinza",
  };
  for (const m of look.motors) roles[m.port] ??= MOVES[m.attachment] ?? "";
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
  fitFog();
  const key = `${focus.id}\n${w.name}`;
  const first = key !== framed;
  // the robot whole, where it is (not where it started), in the part of the canvas no panel covers: behind it and
  // to its right, or from the front when a phone looks ahead, where its face reads. A deep link's angle wins.
  cams.extent = {
    front_cm: w.body.front_cm,
    back_cm: w.body.back_cm,
    half_width_cm: w.body.half_width_cm,
    height_cm: model?.height ?? 20,
  };
  cams.aim.az = look.phone && Math.cos(look.phone.yaw * DEG) > 0.5 ? -135 : -32;
  cams.fitArena(w, first);
  framed = key;
}

/** Does this robot have a sensor whose rays the page draws (ultrasonic, infrared, colour)? */
function hasRays(m: RobotMeta | null): boolean {
  return m !== null && Object.values(m.ports.sensors).some((k) => k === "ultrasonic" || k === "ir" || k === "color");
}
/** The rays option is offered only to a robot that has such a sensor. */
function showConeOption(): void {
  $("opt-cone-row").hidden = !hasRays(focus);
  $("opt-cone-label").textContent = "Rayos de los sensores";
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
    fitFog();
    $("pip").hidden = m === "eye" || !$<HTMLInputElement>("opt-pip").checked;
    canvas.dataset.cam = m;
    hand.refreshHint();
  },
  freeArea,
);
// a deep link's angle, distance or height wins over the first framing
cams.onSnap = (target, heading) => placeCamera(camera, target, heading);
/** The canvas left uncovered by the panels, for the top view. */
function freeArea(): { left: number; top: number; right: number; bottom: number } {
  const r = (id: string) => $(id).getBoundingClientRect();
  const c = canvas.getBoundingClientRect();
  // the hint floats over the scene and fades: it is not a panel, or the scene would jump when it goes
  const top = r("bar").bottom + 8;
  const left = $("tools").classList.contains("folded") ? 12 : r("tools").right + 8;
  const right = $("brick").classList.contains("folded") ? c.width - 12 : r("brick").left - 8;
  const below = document.getElementById("chat") ?? $("callpanel"); // --chat: the chat takes the calls' place
  return {
    left: left - c.left,
    top: top - c.top,
    right: right - c.left,
    bottom: below.getBoundingClientRect().top - 8 - c.top,
  };
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
$("cam-reset").addEventListener("click", () => cams.reset());
$("restore").addEventListener("click", () => {
  if (!focus) return;
  const id = focus.id;
  void link.request({ t: "restore", id }).then((r) => {
    if (!r.ok) return hud.toast(`${hud.REFUSAL[r.code]}${r.code === "internal" ? `: ${r.error}` : ""}`);
    if (focus?.id === id) trailReset();
    const robot = robots.find((x) => x.id === id);
    if (robot) hud.toast(restoredText(robot, r.activity), r.activity === "fault" ? undefined : "info");
  });
});
$("trail-clear").addEventListener("click", () => trailReset());
$<HTMLSelectElement>("robot").addEventListener("change", (e) => setFocus((e.target as HTMLSelectElement).value));
$<HTMLInputElement>("opt-cone").addEventListener("change", (e) => {
  coneGroup.visible = (e.target as HTMLInputElement).checked && hasRays(focus);
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
    b.classList.toggle("down", d); // lit at once; the next state says what the brick holds
    void link.request({ t: "button", id: focus.id, button: btn, down: d }).then((r) => {
      if (!r.ok && d) hud.toast(`Botón: ${hud.REFUSAL[r.code]}`);
      else if (d) hud.activity("🖐", `botón ${b.textContent!.trim() || "●"}`, $("clock").textContent ?? "", b.title);
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
  };
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(key);
  } catch {
    // storage blocked: the fold works, it is only not remembered
  }
  // a narrow window folds the side panels whatever was chosen on a wide one; only a click is remembered
  const side = b.dataset.fold !== "callpanel";
  set((side && narrow.matches) || stored === "1");
  b.addEventListener("click", () => {
    const folded = !panel.classList.contains("folded");
    set(folded);
    stored = folded ? "1" : "0";
    try {
      localStorage.setItem(key, stored);
    } catch {
      // see above
    }
  });
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
  else if (!help.hidden) return; // the help is up: the scene behind it takes no keys
  else if (k === "q" || k === "e") hand.turnKey(k === "q" ? 1 : -1);
  else if (k >= "1" && k <= "5") hand.setMode(MODES[Number(k) - 1]!);
  else if (k === "c") setCam(CAMS[(CAMS.indexOf(cams.mode) + 1) % CAMS.length]!);
  else if (k === "0" || k === "home") cams.reset();
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
  if (!renderer) return;
  const c = renderer.domElement;
  if (c.width !== Math.floor(w * renderer.getPixelRatio()) || c.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    cams.resized();
  }
}
const seeThrough = [new THREE.Vector3(), new THREE.Vector3()];
function updateCone(st: RobotState): void {
  if (coneGroup.visible) sensorRays.update(st.rays);
}

let firstFrame = false;
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

  // the robot's camera
  if (model && s) {
    robotRoot.updateMatrixWorld();
    eyeCam.position.copy(tmpA.copy(model.eye.pos).applyMatrix4(robotRoot.matrixWorld));
    eyeCam.lookAt(tmpB.copy(model.eye.look).applyMatrix4(robotRoot.matrixWorld));
  }
  cams.update(s, model && s ? eyeCam : null);
  // nothing hides the robot from the person's camera: a box or a wall in the way turns see-through meanwhile
  if (arena && s && model && cams.mode !== "eye" && cams.mode !== "top") {
    const base = toScene(s.x, s.y);
    seeThrough[0]!.set(base.x, model.height * 0.5, base.z);
    seeThrough[1]!.set(base.x, model.height * 0.9, base.z);
    arena.clearView(camera.position, seeThrough);
  } else arena?.clearView(camera.position, []);
  hand.frame();
  // the robot's camera sees what the robot sees, never the helpers
  if (cams.mode === "eye" && model && s) camera.layers.disable(HELPERS);
  else camera.layers.enable(HELPERS);

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

  if (!renderer) return; // no 3D: the panels go on, the scene is a message
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  scene.updateMatrixWorld();
  shadowFrame(now);
  const pip = $("pip");
  const pipOn = !pip.hidden && model !== null && s !== null;
  const pr = pipOn ? pip.getBoundingClientRect() : null;
  const cr = pipOn ? canvas.getBoundingClientRect() : null;
  if (pr && cr) {
    eyeCam.aspect = pr.width / pr.height;
    eyeCam.updateProjectionMatrix();
  }
  // the cameras are not in the scene: their world matrices are brought up to date here, before they are compared
  camera.updateMatrixWorld();
  if (pipOn) eyeCam.updateMatrixWorld();
  // nothing to draw that the canvas does not show already: the frame costs a look at the scene, not a render
  const extra = [canvas.width, canvas.height, renderer.shadowMap.needsUpdate ? 1 : 0];
  if (pr && cr) extra.push(pr.left - cr.left, cr.bottom - pr.bottom, pr.width, pr.height);
  if (!still.changed(scene, pipOn ? [camera, eyeCam] : [camera], extra)) return frameStats(renderer, now);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
  renderer.render(scene, camera);
  // the first frame that shows a robot, for a test or a person in the console (bench/page.ts times it)
  if (robotRoot.visible && !firstFrame) {
    firstFrame = true;
    performance.mark("twin:first-frame");
  }
  if (model && pr && cr) {
    const r = pr;
    const x = r.left - cr.left,
      y = cr.bottom - r.bottom;
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

hand.setMode("look");
applyLink(setCam);
requestAnimationFrame(frame);
