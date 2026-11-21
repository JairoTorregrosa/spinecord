// The robot page: the DOM around src/session.ts. It reads the form, starts the session and draws its
// snapshots. No robot logic here.
import {
  buildPageConfig,
  ConfigError,
  formatHash,
  parseHash,
  type ConfigField,
  type PageConfig,
  type ProfileEntry,
} from "./config";
import { pickCopy, type Copy } from "./copy";
import { createSession, type HidApi, type Snapshot } from "./session";

const t = pickCopy(navigator.language);
const PASTE = "__paste__";
const TOKEN_KEY = "spinecord.robot-page.token";
const JSON_KEY = "spinecord.robot-page.profile-json";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`robot page: index.html has no #${id}`);
  return node as T;
}
// sessionStorage can be blocked (private mode, policy): the page still works, the token just is not kept.
const stored = {
  get(key: string): string {
    try {
      return sessionStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  },
  set(key: string, value: string): void {
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    } catch {
      /* not kept */
    }
  },
};

document.documentElement.lang = t.lang;
for (const node of document.querySelectorAll<HTMLElement>("[data-t]")) {
  const text = t[node.dataset.t as keyof Copy];
  if (typeof text !== "string") throw new Error(`robot page: copy has no string "${node.dataset.t}"`);
  node.textContent = text;
}

const fields = {
  server: el<HTMLInputElement>("server"),
  robot: el<HTMLInputElement>("robot"),
  token: el<HTMLInputElement>("token"),
  profile: el<HTMLSelectElement>("profile"),
};
const profileJson = el<HTMLTextAreaElement>("profile-json");
const profileJsonField = el("profile-json-field");
const connectBtn = el<HTMLButtonElement>("connect");
const disconnectBtn = el<HTMLButtonElement>("disconnect");
const stopBtn = el<HTMLButtonElement>("stop");
const notices = el("notices");

// ---- notices: what went wrong, in the person's language, with the technical detail underneath ----
interface Notice {
  kind: "error" | "info" | "ok";
  text: string;
  detail?: string;
}
let pageNotices: Notice[] = []; // from this file (form errors, token in the address)
let lastNoticeKey = "";
function drawNotices(snapshot: Snapshot): void {
  const all = [...pageNotices];
  if (snapshot.problem)
    all.push({ kind: "error", text: t.problem[snapshot.problem.code], detail: snapshot.problem.detail });
  else if (snapshot.lastStop?.motors_stopped)
    all.push({ kind: "ok", text: `${t.stopped}: ${t.stopWhy[snapshot.lastStop.why]}.` });
  const key = JSON.stringify(all);
  if (key === lastNoticeKey) return; // an unchanged alert is not announced again
  lastNoticeKey = key;
  notices.replaceChildren(
    ...all.map((n) => {
      const p = document.createElement("p");
      p.className = "notice";
      p.dataset.kind = n.kind;
      p.append(n.text);
      if (n.detail) {
        const code = document.createElement("code");
        code.textContent = `${t.detail}: ${n.detail}`;
        p.append(code);
      }
      return p;
    }),
  );
}

// ---- form: hash ↔ fields (never the token), sessionStorage for the token ----
const hash = parseHash(location.hash);
fields.server.value = hash.server;
fields.robot.value = hash.robot;
fields.token.value = stored.get(TOKEN_KEY);
profileJson.value = stored.get(JSON_KEY);
let profiles: ProfileEntry[] = [];

const writeHash = () => {
  const profile = fields.profile.value === PASTE ? "" : fields.profile.value;
  const next = formatHash({ server: fields.server.value.trim(), robot: fields.robot.value.trim(), profile });
  history.replaceState(null, "", `${location.pathname}${location.search}${next}`);
};
if (hash.hadToken) {
  pageNotices.push({ kind: "error", text: t.hiddenTokenInUrl });
  history.replaceState(null, "", `${location.pathname}${location.search}${formatHash(hash)}`);
}
const showPaste = () => {
  profileJsonField.hidden = fields.profile.value !== PASTE;
};
function fillProfiles(wanted: string): void {
  fields.profile.replaceChildren(
    ...profiles.map((p) => new Option(`${p.config.profile.id} (${p.id})`, p.id)),
    new Option(t.profilePaste, PASTE),
  );
  if (wanted && profiles.some((p) => p.id === wanted)) fields.profile.value = wanted;
  else if (wanted) {
    fields.profile.value = PASTE;
    pageNotices.push({ kind: "error", text: `${t.field.profile}: "${wanted}"`, detail: "not in profiles.json" });
  } else if (profileJson.value || profiles.length === 0) fields.profile.value = PASTE;
  showPaste();
}
function readForm(): PageConfig {
  const chosen = fields.profile.value;
  const entry = profiles.find((p) => p.id === chosen);
  if (chosen !== PASTE && !entry) throw new ConfigError("profile", `no profile "${chosen}" in profiles.json`);
  return buildPageConfig({
    server: fields.server.value,
    robot: fields.robot.value,
    token: fields.token.value,
    robot_json: entry ? entry.config : profileJson.value,
  });
}
function markInvalid(field: ConfigField | null): void {
  for (const [name, input] of Object.entries(fields)) input.setAttribute("aria-invalid", String(name === field));
  profileJson.setAttribute("aria-invalid", String(field === "profile" && fields.profile.value === PASTE));
}
for (const input of [fields.server, fields.robot, fields.profile]) input.addEventListener("change", writeHash);
fields.token.addEventListener("input", () => stored.set(TOKEN_KEY, fields.token.value));
profileJson.addEventListener("input", () => stored.set(JSON_KEY, profileJson.value));
fields.profile.addEventListener("change", showPaste);

// ---- session ----
const hid = (navigator as unknown as { hid?: HidApi }).hid;
let latest: Snapshot;
let frame = 0;
const session = createSession({
  ...(hid ? { hid } : {}),
  onChange(s) {
    latest = s;
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        draw(latest);
      });
  },
});
latest = session.snapshot();

async function connect(prompt: boolean): Promise<void> {
  let cfg: PageConfig;
  try {
    cfg = readForm();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    if (!prompt) return; // on load an incomplete form is not an error yet
    pageNotices = [{ kind: "error", text: `${t.field[e.field]}: ${e.message}` }];
    markInvalid(e.field);
    (e.field === "profile" && fields.profile.value === PASTE ? profileJson : fields[e.field]).focus();
    return draw(latest);
  }
  pageNotices = [];
  markInvalid(null);
  writeHash();
  await session.connect(cfg, { prompt });
}
el<HTMLFormElement>("setup").addEventListener("submit", (ev) => {
  ev.preventDefault();
  void connect(true);
});
disconnectBtn.addEventListener("click", () => void session.disconnect());

// ---- STOP: the button and the keyboard. It only needs the USB cable, not the server. ----
function stop(): void {
  if (latest.device !== "ready") {
    pageNotices = [{ kind: "info", text: t.stopNothing }];
    return draw(latest);
  }
  void session.stop("local");
}
stopBtn.addEventListener("click", stop);
window.addEventListener("keydown", (ev) => {
  if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const typing =
    ev.target instanceof HTMLElement &&
    (ev.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(ev.target.tagName));
  // Escape always stops. Space stops unless the person is typing; on a focused button it stops instead of
  // pressing that button (Enter still presses it).
  if (ev.key === "Escape" || ((ev.key === " " || ev.code === "Space") && !typing)) {
    ev.preventDefault();
    stop();
  }
});
document.addEventListener("visibilitychange", () => session.setHidden(document.hidden));
window.addEventListener("pagehide", () => session.pageHide());

// ---- drawing ----
const text = (id: string, value: string) => {
  const node = el(id);
  if (node.textContent !== value) node.textContent = value;
};
const show = (v: unknown): string =>
  v === null || v === undefined
    ? t.noValue
    : typeof v === "number"
      ? String(Math.round(v * 100) / 100)
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
let devicesKey = "";
let callsKey = -1;

function draw(s: Snapshot): void {
  drawNotices(s);
  const unsupported = s.device === "unsupported";
  el<HTMLFieldSetElement>("fields").disabled = unsupported || s.device === "opening";
  connectBtn.disabled = unsupported || s.device === "opening";
  connectBtn.textContent =
    s.device === "opening" ? t.connecting : s.device === "ready" || s.device === "lost" ? t.reconnect : t.connect;
  disconnectBtn.hidden = s.device !== "ready" && s.device !== "lost";

  el("link-pill").dataset.link = s.link;
  text("link-pill-text", t.linkState[s.link]);
  el("s-link").dataset.link = s.link;
  text("s-link", t.linkState[s.link]);
  text("s-link-detail", s.link === "offline" && s.device === "ready" ? s.linkDetail : "");
  text(
    "s-activity",
    s.tool && s.activity === "busy" ? `${t.activityState.busy} ${s.tool}` : t.activityState[s.activity],
  );
  const battery = el("s-battery");
  battery.dataset.low = String(s.battery?.low === true);
  text(
    "s-battery",
    !s.battery || s.battery.voltage_v === null
      ? t.noValue
      : `${s.battery.voltage_v.toFixed(2)} V${s.battery.low ? ` (${t.batteryLow})` : ""}`,
  );
  text("s-brick", s.deviceName ? `${t.deviceState[s.device]} · ${s.deviceName}` : t.deviceState[s.device]);

  // devices: rebuild only when the set changes, then update the values in place
  const list = el("devices");
  const key = JSON.stringify(s.devices.map((d) => [d.id, d.kind, d.roles, d.channels.map((c) => c.name)]));
  if (key !== devicesKey) {
    devicesKey = key;
    list.replaceChildren(
      ...s.devices.map((d) => {
        const li = document.createElement("li");
        li.title = d.description;
        const id = document.createElement("span");
        id.className = "id";
        id.textContent = d.id;
        const kind = document.createElement("span");
        kind.className = "kind";
        kind.textContent = ` ${[d.kind, ...d.roles].join(" · ")}`;
        li.append(id, kind);
        if (d.channels.length) {
          const dl = document.createElement("dl");
          for (const c of d.channels) {
            const dt = document.createElement("dt");
            dt.textContent = c.unit ? `${c.name} (${c.unit})` : c.name;
            const dd = document.createElement("dd");
            dd.dataset.channel = `${d.id}.${c.name}`;
            dl.append(dt, dd);
          }
          li.append(dl);
        }
        return li;
      }),
    );
  }
  el("no-devices").hidden = s.devices.length > 0;
  const cells = new Map(
    [...list.querySelectorAll<HTMLElement>("dd[data-channel]")].map((dd) => [dd.dataset.channel, dd]),
  );
  for (const d of s.devices)
    for (const c of d.channels) {
      const dd = cells.get(`${d.id}.${c.name}`);
      if (!dd) continue;
      const state = !c.active ? "inactive" : c.error ? "error" : "value";
      const value = state === "inactive" ? t.inactive : state === "error" ? String(c.error) : show(c.value);
      if (dd.dataset.state !== state) dd.dataset.state = state;
      if (dd.textContent !== value) dd.textContent = value;
    }

  const newest = s.calls[0]?.seq ?? 0;
  if (newest !== callsKey) {
    callsKey = newest;
    el("calls").hidden = s.calls.length === 0;
    el("no-calls").hidden = s.calls.length > 0;
    el("calls-body").replaceChildren(
      ...s.calls.map((c) => {
        const tr = document.createElement("tr");
        tr.dataset.ok = String(c.ok);
        for (const [value, cls] of [
          [c.tool, ""],
          [c.reason, ""],
          [String(c.ms), "num"],
        ] as const) {
          const td = document.createElement("td");
          if (cls) td.className = cls;
          td.textContent = value;
          tr.append(td);
        }
        return tr;
      }),
    );
  }
}

// ---- start: the profile list, then reconnect to an EV3 this browser already has permission for ----
async function start(): Promise<void> {
  try {
    const res = await fetch("profiles.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`profiles.json: HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new Error("profiles.json is not a list");
    profiles = body as ProfileEntry[];
  } catch (e) {
    pageNotices.push({ kind: "error", text: t.noProfiles, detail: String((e as Error)?.message ?? e) });
  }
  fillProfiles(hash.profile);
  draw(latest);
  if (latest.device !== "unsupported") await connect(false);
}
void start();
