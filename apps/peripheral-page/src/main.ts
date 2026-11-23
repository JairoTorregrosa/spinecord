// The DOM around src/page.ts: the setup form and the one tap, the banner, the screen, the buttons and the list of
// what is lent. The token and the robots come from the meta tags of the page the process served; a join link's
// fragment may name the page, the robot and the language (#name=phone&robot=r1&lang=es-ES). Nothing is stored.
import type { Win } from "./browser";
import type { View, ScreenDraw } from "./devices/display";
import { drawFace } from "./faces";
import type { KitActivity, KitState, KitStatus } from "./kit";
import { createPage } from "./page";

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`peripheral page: element #${id} is missing`);
  return node as T;
};
const meta = (name: string): string => {
  const v = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
  if (v === undefined)
    throw new Error(`peripheral page: meta ${name} is missing; open the page the spinecord process serves`);
  return v;
};
const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get("t") ?? meta("spinecord-token");
const robots = meta("spinecord-robots").split(" ").filter(Boolean);
const lang = fragment.get("lang") ?? meta("spinecord-lang");
const touchScreen = matchMedia("(pointer: coarse)").matches;

// ---------- setup ----------
const nameInput = el<HTMLInputElement>("name");
nameInput.value = fragment.get("name") ?? (touchScreen ? "phone" : "desk");
const robotSelect = el<HTMLSelectElement>("robot");
for (const r of robots) robotSelect.append(new Option(r, r));
const wanted = fragment.get("robot");
if (wanted && robots.includes(wanted)) robotSelect.value = wanted;
el("robot-row").hidden = robots.length < 2;
el("robot-one").textContent = robots[0] ?? "";
el("robot-one").parentElement!.hidden = robots.length !== 1;

// ---------- the screen ----------
const face = el("face");
function render(view: View, draw: ScreenDraw | null): void {
  face.style.background = "";
  face.className = `screen screen-${view.t}`;
  if (view.t === "face") {
    if (draw) draw(face, view.args);
    else drawFace(face, view.name);
  } else if (view.t === "text") {
    face.replaceChildren(...view.lines.map((l) => Object.assign(document.createElement("p"), { textContent: l })));
  } else if (view.t === "color") {
    face.replaceChildren();
    face.style.background = view.color;
  } else face.replaceChildren();
}
el("be-face").addEventListener("click", () => {
  document.body.classList.add("face-mode");
  void document.documentElement.requestFullscreen?.().catch(() => {});
});
face.addEventListener("dblclick", leaveFace);
document.addEventListener("keydown", (e) => e.key === "Escape" && leaveFace());
el("leave-face").addEventListener("click", leaveFace);
function leaveFace(): void {
  document.body.classList.remove("face-mode");
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
}

// ---------- touch buttons ----------
const pads = [...document.querySelectorAll<HTMLButtonElement>("#pads button")];
function drawLabels(labels: string[]): void {
  pads.forEach((b, i) => {
    b.textContent = labels[i] ?? "";
    b.hidden = !labels[i];
  });
}

// ---------- the page ----------
const page = createPage({
  win: window as unknown as Win,
  url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/page`,
  token,
  openSocket: (url) => new WebSocket(url) as never,
  visible: () => document.visibilityState === "visible",
  lang,
  workletUrl: "level.js",
  render,
  onLabels: drawLabels,
  onStatus: draw,
  onActivity: activity,
  onWake: () => draw(),
});
(window as unknown as { spinecord: unknown }).spinecord = page.spinecord;
pads.forEach((b, i) => {
  b.addEventListener("pointerdown", (e) => {
    b.setPointerCapture(e.pointerId);
    page.touch.press(i);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const)
    b.addEventListener(type, () => page.touch.release(i));
  b.addEventListener("contextmenu", (e) => e.preventDefault());
});

const lendButton = el<HTMLButtonElement>("lend");
lendButton.addEventListener("click", () => {
  const name = nameInput.value.trim();
  if (!/^[a-z][a-z0-9_-]{0,15}$/.test(name) || name === "ev3" || name === "sim") {
    el("setup-error").textContent =
      "The name is 1 to 16 lowercase letters, digits, - or _, starting with a letter, and not ev3 or sim.";
    return;
  }
  el("setup-error").textContent = "";
  lendButton.disabled = true;
  lendButton.textContent = "Asking the browser…";
  page.lend({ name, robot: robots.length > 1 ? robotSelect.value : undefined }).catch((e: unknown) => {
    el("setup-error").textContent = `Could not lend: ${(e as Error).message}`;
    lendButton.disabled = false;
    lendButton.textContent = "Lend this device";
  });
});

// ---------- banner and status ----------
const pause = el<HTMLButtonElement>("pause");
pause.addEventListener("click", () => {
  if (page.kit.status().held) page.kit.resume();
  else page.kit.pause("the person pressed pause");
});
el("stop-lending").addEventListener("click", () => page.stopLending());
// the browser asks again for the camera or the microphone only in a tap: this one
el("resume-media").addEventListener("click", () => void page.resumeMedia().then(() => draw()));
el("reload").addEventListener("click", () => location.reload());

const KIND_NAMES: Record<string, string> = {
  camera: "camera",
  mic: "microphone",
  speaker: "speaker",
  screen: "screen",
  touch: "buttons",
  imu: "motion sensors",
  vibrator: "vibration",
  torch: "torch",
};
let listening = false;
let lastFrame: number | null = null;

// every state has its words: a state added to the kit without them fails the type check
const STATUS_TEXT: Record<KitState, (s: KitStatus) => string> = {
  idle: () => "Not lent",
  joining: (s) => (s.rejoin ? "Reconnecting…" : "Joining…"),
  lending: (s) => `Lent to ${s.robot} as ${s.name}`,
  paused: (s) => `Paused · ${s.name}`,
  reconnecting: () => "Reconnecting…",
  closed: () => "Closed",
};

function draw(s: KitStatus = page.kit.status()): void {
  const away = s.rejoin !== null;
  const lending = s.state === "lending" || s.state === "paused" || away;
  const sensitive = s.devices.filter((d) => d === "camera" || d === "mic" || d === "imu");
  el("setup").hidden = s.state !== "idle";
  el("lent").hidden = !lending && s.state !== "closed";
  el("closed").hidden = s.state !== "closed";
  if (s.closed)
    el("closed-why").textContent =
      `${s.closed.reason || "The connection closed"} (code ${s.closed.code}). Reload this page when the spinecord process runs again.`;
  const banner = el("banner");
  banner.hidden = !lending || (sensitive.length === 0 && !away);
  banner.classList.toggle("paused", s.state === "paused");
  banner.classList.toggle("reconnecting", away);
  el("banner-what").textContent = away
    ? `Reconnecting… the robot keeps this page's place for 30 s${s.held ? "; lending stays paused" : ""}.`
    : s.state === "paused"
      ? `Paused: the robot cannot use the ${sensitive.map((d) => KIND_NAMES[d]).join(" or ")}.`
      : `${sensitive.map((d) => KIND_NAMES[d]).join(" and ")} lent to robot ${s.robot}${listening ? " · listening…" : ""}`.replace(
          /^./,
          (c) => c.toUpperCase(),
        );
  el("banner-frame").textContent = lastFrame === null ? "" : `Last frame ${new Date(lastFrame).toLocaleTimeString()}`;
  el("banner-speech").hidden = !page.kit
    .manifest()
    .devices.some((d) => d.id === "mic" && d.commands.some((c) => c.name === "listen"));
  pause.textContent = s.held ? "Resume" : "Pause";
  const waiting = page.needsTap();
  el("resume-media").hidden = waiting.length === 0;
  if (waiting.length) banner.hidden = false;
  el("status").textContent = STATUS_TEXT[s.state](s);
  el("status").dataset.state = s.state;
  const list = el("lent-list");
  list.replaceChildren(
    ...s.devices.map((d) => li(`${KIND_NAMES[d] ?? d}`, `${s.name}.${d}`, "ok")),
    ...s.unavailable.map((u) => li(u.kind, u.why.replace(/^[^:]+: /, ""), "no")),
    ...(lending ? [wakeItem()] : []),
  );
  const preview = el<HTMLVideoElement>("preview");
  const stream = page.live().camera;
  if (preview.srcObject !== stream) preview.srcObject = stream as MediaStream | null;
  preview.hidden = !stream || !s.devices.includes("camera");
  document.title = lending
    ? `${away ? "Reconnecting" : s.state === "paused" ? "Paused" : "Lent"} · ${s.name} · spinecord`
    : "Lend this device · spinecord";
}
function wakeItem(): HTMLLIElement {
  const w = page.wake();
  if (w.t === "held") return li("screen", "kept on while lending", "ok");
  if (w.t === "refused") return li("screen", `may lock: ${w.why}`, "no");
  if (w.t === "unsupported") return li("screen", "may lock: this browser cannot keep it on; keep it on yourself", "no");
  return li("screen", "may lock: bring the page to the front to keep it on", "no");
}
function li(what: string, detail: string, cls: string): HTMLLIElement {
  const item = document.createElement("li");
  item.className = cls;
  const b = document.createElement("strong");
  b.textContent = what;
  const span = document.createElement("span");
  span.textContent = detail;
  item.append(b, span);
  return item;
}
function activity(a: KitActivity): void {
  if (a.t === "frame") {
    lastFrame = a.at;
    const banner = el("banner");
    banner.classList.remove("flash");
    void banner.offsetWidth; // restart the animation
    banner.classList.add("flash");
  } else if (a.device === "mic" && a.command === "listen") {
    listening = a.phase === "start";
    el("banner").classList.toggle("listening", listening);
  }
  draw();
}
document.addEventListener("visibilitychange", () => {
  page.visibilityChanged();
  draw();
});
draw();
