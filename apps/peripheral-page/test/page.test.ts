// The peripheral page against a fake browser and a fake socket: the manifest built from feature detection, the
// refusals that land in `unavailable`, listen matching `expect`, speak and tone, the screen and the buttons, the
// extension API, and the wire protocol the kit speaks (CONTRACT §2.4). Every manifest passes validatePageManifest.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { validatePageManifest } from "../../../packages/protocol/validate";
import type { PageDevice } from "../../../packages/protocol/types";
import { matchPhrase, norm } from "../src/devices/microphone";
import { fit } from "../src/devices/camera";
import { voiceFor } from "../src/devices/speaker";
import { createPage } from "../src/page";
import type { View } from "../src/devices/display";
import { fakeBrowser, fakeSocket, tick, VOICES, type FakeBrowserOptions } from "./fakes";

function rig(o: FakeBrowserOptions = {}) {
  const browser = fakeBrowser(o);
  const sock = fakeSocket();
  const views: View[] = [];
  let labels: string[] = [];
  let visible = true;
  const page = createPage({
    win: browser.win,
    url: "ws://127.0.0.1:1/page",
    token: "tok",
    openSocket: () => {
      sock.socket.opened++;
      return sock.socket;
    },
    visible: () => visible,
    lang: "es-ES",
    workletUrl: "level.js",
    render: (v) => void views.push(v),
    onLabels: (l) => void (labels = l),
  });
  /** Taps "Lend", opens the socket, welcomes the page. Resolves with the hello. */
  const join = async (name = "desk") => {
    await page.lend({ name });
    sock.open();
    const hello = sock.json().find((m) => m.t === "hello")!;
    sock.receive({ t: "welcome", name, robot: "r1" });
    return hello as {
      devices: PageDevice[];
      unavailable: { kind: string; why: string }[];
      name: string;
      token: string;
    };
  };
  let nextId = 0;
  /** Sends a request as the process does and resolves with the page's res (and the binary after it, if any). */
  const req = async (m: Record<string, unknown>, waitMs = 50) => {
    const id = ++nextId;
    const before = sock.sent.length;
    sock.receive({ t: "req", id, ...m });
    for (let i = 0; i < waitMs / 5 + 400; i++) {
      const i0 = sock.sent.slice(before).findIndex((x: any) => x && x.t === "res" && x.id === id);
      if (i0 >= 0) {
        const res = sock.sent[before + i0] as any;
        const bin = sock.sent[before + i0 + 1];
        return { res, binary: bin instanceof Uint8Array ? bin : undefined };
      }
      await tick(5);
    }
    throw new Error(`no answer to request ${id}`);
  };
  /** The page is hidden (a locked phone) or visible again: the visibilitychange main.ts forwards. */
  const setVisible = (v: boolean) => {
    visible = v;
    page.visibilityChanged();
  };
  return { browser, sock, page, views, labels: () => labels, join, req, setVisible };
}
const ids = (devices: PageDevice[]) => devices.map((d) => d.id);
const REPO = joinPath(import.meta.dir, "..", "..", "..");
/** A file of the example extensions (deployments/example/page-ext). */
const extFile = (name: string) => readFileSync(joinPath(REPO, "deployments", "example", "page-ext", name), "utf8");
/**
 * Runs an extension file as the page runs it after its kit, with `spinecord` and a document whose body takes a pad
 * element (the examples' only use of the DOM); `globals` stands for the browser's own (BarcodeDetector).
 */
function runExtension(spinecord: unknown, code: string, globals: Record<string, unknown> = {}) {
  const listeners: Record<string, () => void> = {};
  const pad = { className: "", addEventListener: (t: string, cb: () => void) => void (listeners[t] = cb) };
  const document = { body: { appendChild: (el: unknown) => el }, createElement: () => pad };
  new Function("spinecord", "document", "globalThis", code)(spinecord, document, globals);
  return { listeners, pad };
}
/** The kinds a phone has and a computer lacks: a test of the computer's kinds leaves them out. */
const PHONE_KINDS = ["imu", "vibrator", "torch"];
const own = (u: { kind: string; why: string }[]) => u.filter((x) => !PHONE_KINDS.includes(x.kind));
const cmds = (devices: PageDevice[], id: string) => devices.find((d) => d.id === id)?.commands.map((c) => c.name);
const chans = (devices: PageDevice[], id: string) => devices.find((d) => d.id === id)?.channels.map((c) => c.name);

describe("the manifest, from feature detection", () => {
  test("a browser with everything lends every kind, and the manifest passes the process's check", async () => {
    const { join } = rig();
    const hello = await join();
    expect(validatePageManifest(hello.devices)).toEqual([]);
    expect(ids(hello.devices).sort()).toEqual(["camera", "mic", "screen", "speaker", "touch"]);
    // a computer's browser: no motion sensors, no vibration, a webcam without a torch
    expect(hello.unavailable).toEqual([
      { kind: "imu", why: "imu: this browser has no motion sensors" },
      { kind: "vibrator", why: "vibrator: this browser has no vibration" },
      {
        kind: "torch",
        why: "torch: the lent camera has no torch the browser can switch (on a phone the torch is usually next to the camera facing environment)",
      },
    ]);
    expect(cmds(hello.devices, "mic")).toEqual(["listen"]);
    expect(chans(hello.devices, "mic")).toContain("level_pct");
    expect(cmds(hello.devices, "speaker")).toEqual(["speak", "tone"]);
    expect(cmds(hello.devices, "screen")).toEqual(["text", "clear", "face", "color"]);
    expect(hello.token).toBe("tok");
    const roles = Object.fromEntries(hello.devices.map((d) => [d.id, d.roles]));
    expect(roles).toMatchObject({
      camera: ["eyes"],
      mic: ["ears"],
      speaker: ["voice"],
      screen: ["face"],
      touch: ["touch"],
    });
  });

  test("without speech recognition the microphone has no listen and keeps level_pct", async () => {
    const hello = await rig({ recognition: false }).join();
    expect(validatePageManifest(hello.devices)).toEqual([]);
    expect(cmds(hello.devices, "mic")).toEqual([]);
    expect(chans(hello.devices, "mic")).toContain("level_pct");
    expect(hello.devices.find((d) => d.id === "mic")!.description).toContain("no speech recognition");
  });

  test("the unprefixed SpeechRecognition is found too", async () => {
    const hello = await rig({ recognition: "SpeechRecognition" }).join();
    expect(cmds(hello.devices, "mic")).toEqual(["listen"]);
  });

  test("a microphone with neither recognition nor a level meter is not lent, with its reason", async () => {
    const hello = await rig({ recognition: false, worklet: false }).join();
    expect(ids(hello.devices)).not.toContain("mic");
    expect(own(hello.unavailable)).toEqual([
      { kind: "microphone", why: "microphone: this browser has neither speech recognition nor an audio level meter" },
    ]);
  });

  test("a refused camera and a refused microphone land in unavailable with their reasons", async () => {
    const { join, browser } = rig({ camera: "NotAllowedError", microphone: "NotAllowedError" });
    const hello = await join();
    expect(browser.asked.sort()).toEqual(["camera", "microphone"]);
    expect(ids(hello.devices).sort()).toEqual(["screen", "speaker", "touch"]);
    expect(own(hello.unavailable)).toEqual([
      { kind: "camera", why: "camera: the person did not allow it" },
      { kind: "microphone", why: "microphone: the person did not allow it" },
    ]);
    expect(validatePageManifest(hello.devices)).toEqual([]);
  });

  test("a computer with no camera says so", async () => {
    const hello = await rig({ camera: "NotFoundError" }).join();
    expect(own(hello.unavailable)).toEqual([{ kind: "camera", why: "camera: this computer has no camera" }]);
  });

  test("a browser without media devices, synthesis or audio lends the screen and the buttons only", async () => {
    const hello = await rig({ media: false, synthesis: false, audio: false }).join();
    expect(ids(hello.devices).sort()).toEqual(["screen", "touch"]);
    expect(
      own(hello.unavailable)
        .map((u) => u.kind)
        .sort(),
    ).toEqual(["camera", "microphone", "speaker"]);
    expect(hello.unavailable.find((u) => u.kind === "camera")!.why).toContain("mediaDevices.getUserMedia");
  });

  test("a camera without ImageCapture is not lent", async () => {
    const hello = await rig({ imageCapture: false }).join();
    expect(own(hello.unavailable)).toEqual([
      { kind: "camera", why: "camera: this browser cannot take a frame from the camera" },
    ]);
  });

  test("speak lists only the voices and languages the browser has; tone needs Web Audio", async () => {
    const hello = await rig({ audio: false }).join();
    const speak = hello.devices.find((d) => d.id === "speaker")!.commands.find((c) => c.name === "speak")!;
    const p = speak.params.properties as Record<string, { enum?: string[] }>;
    expect(p.voice!.enum).toEqual(["Mónica", "Paulina", "Samantha"]);
    expect(p.lang!.enum).toEqual(["en-US", "es-ES", "es-MX"]);
    expect(speak.description).toContain("Mónica (es-ES)");
    expect(cmds(hello.devices, "speaker")).toEqual(["speak"]);
  });

  test("a browser that lists no voice has no speak", async () => {
    const hello = await rig({ voices: [] }).join();
    expect(cmds(hello.devices, "speaker")).toEqual(["tone"]);
  });

  test("configure offers facing only where there is more than one camera", async () => {
    const one = await rig().join();
    const two = await rig({ cameras: 2 }).join();
    const facing = (h: typeof one) =>
      "facing" in (h.devices.find((d) => d.id === "camera")!.commands[0]!.params.properties as object);
    expect(facing(one)).toBe(false);
    expect(facing(two)).toBe(true);
    expect(validatePageManifest(two.devices)).toEqual([]);
  });
});

describe("nothing is lent without a tap", () => {
  test("no socket, no camera and no microphone before lend()", async () => {
    const { sock, browser, page } = rig();
    await tick(10);
    expect(sock.socket.opened).toBe(0);
    expect(browser.asked).toEqual([]);
    expect(page.kit.status().state).toBe("idle");
  });

  test("the page's source uses no storage", () => {
    const dir = joinPath(import.meta.dir, "..", "src");
    const files = readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".ts"));
    for (const f of files) {
      const text = readFileSync(joinPath(dir, String(f)), "utf8");
      expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./);
    }
  });
});

describe("the wire protocol", () => {
  test("the page answers pings with its visibility, from the message handler", async () => {
    const { join, sock } = rig();
    await join();
    sock.receive({ t: "ping", n: 7 });
    expect(sock.json().at(-1)).toEqual({ t: "pong", n: 7, visible: true });
  });

  test("after the welcome every pushed channel has a value", async () => {
    const { join, sock } = rig();
    const hello = await join();
    const pushed = new Map<string, Set<string>>();
    for (const m of sock.json().filter((x) => x.t === "state"))
      for (const k of Object.keys(m.values))
        (pushed.get(m.device) ?? pushed.set(m.device, new Set()).get(m.device)!).add(k);
    for (const d of hello.devices)
      for (const c of d.channels.filter((c) => c.pushed)) expect(pushed.get(d.id)?.has(c.name)).toBe(true);
  });

  test("a frame is a res with image, then its bytes", async () => {
    const { join, req } = rig();
    await join();
    const { res, binary } = await req({ op: "read", device: "camera", channels: ["frame", "width_px", "facing"] });
    expect(res.ok).toBe(true);
    expect(res.image).toMatchObject({ channel: "frame", mime: "image/jpeg" });
    expect(res.image.bytes).toBe(binary!.length);
    expect(res.image.age_ms).toBeGreaterThanOrEqual(0);
    expect(res.readings).toEqual({ width_px: 640, facing: "user" });
    // the bytes are a JPEG of the configured size
    expect([binary![9]! * 256 + binary![10]!, binary![7]! * 256 + binary![8]!]).toEqual([640, 360]);
  });

  test("configure changes the size of the next frames", async () => {
    const { join, req } = rig();
    await join();
    const c = await req({
      op: "command",
      device: "camera",
      command: "configure",
      args: { max_side_px: 320, quality: 0.5 },
      deadline_ms: 2000,
    });
    expect(c.res.result).toEqual({
      measured: { max_side_px: 320, quality: 0.5, width_px: 320, height_px: 180, facing: "user" },
      reason: "completed",
    });
    const { res } = await req({ op: "read", device: "camera", channels: ["width_px", "height_px"] });
    expect(res.readings).toMatchObject({ width_px: 320, height_px: 180 });
  });

  test("a muted camera track is down, unmuted it is up", async () => {
    const { join, sock, browser } = rig();
    await join();
    browser.video.fire("mute");
    expect(sock.json().at(-1)).toEqual({ t: "down", device: "camera", why: "the camera stopped sending pictures" });
    browser.video.fire("unmute");
    expect(sock.json().at(-1)).toEqual({ t: "up", device: "camera" });
  });

  test("an unknown command answers unknown_command, an unknown device device_offline", async () => {
    const { join, req } = rig();
    await join();
    expect(
      (await req({ op: "command", device: "camera", command: "zoom", args: {}, deadline_ms: 1 })).res.error.code,
    ).toBe("unknown_command");
    expect((await req({ op: "read", device: "door", channels: ["x"] })).res.error.code).toBe("device_offline");
  });

  test("pause says paused and answers requests with device_offline; resume says resumed", async () => {
    const { join, sock, page, req } = rig();
    await join();
    page.kit.pause("test");
    expect(sock.json().at(-1)).toEqual({ t: "paused", why: "test" });
    expect((await req({ op: "read", device: "camera", channels: ["frame"] })).res.error.code).toBe("device_offline");
    page.kit.resume();
    expect(sock.json().at(-1)).toEqual({ t: "resumed" });
  });

  test("stop lending: the camera and microphone leave the manifest, their tracks stop, their pushes stop", async () => {
    const { join, sock, page, browser } = rig();
    await join();
    page.stopLending();
    expect(browser.video.stopped).toBe(true);
    expect(browser.audioTrack.stopped).toBe(true);
    const devices = sock
      .json()
      .filter((m) => m.t === "devices")
      .at(-1)!;
    expect(ids(devices.devices).sort()).toEqual(["screen", "speaker", "touch"]);
    expect(own(devices.unavailable)).toEqual([
      { kind: "camera", why: "camera: the person stopped lending it" },
      { kind: "microphone", why: "microphone: the person stopped lending it" },
    ]);
    const n = sock.sent.length;
    browser.level(80);
    expect(sock.sent.length).toBe(n);
  });

  test("the process's stop ends a speak in flight and is answered at once", async () => {
    const { join, req, browser } = rig();
    await join();
    browser.synth.hold = true;
    const speaking = req({
      op: "command",
      device: "speaker",
      command: "speak",
      args: { text: "hola" },
      deadline_ms: 15000,
    });
    await tick(10);
    const stop = await req({ op: "stop" });
    expect(stop.res).toEqual({ t: "res", id: stop.res.id, ok: true });
    expect((await speaking).res.result).toEqual({ measured: { spoken: false }, reason: "preempted" });
  });

  test("an abort ends the command it names", async () => {
    const { join, sock, browser } = rig();
    await join();
    browser.hear("silence");
    sock.receive({
      t: "req",
      id: 50,
      op: "command",
      device: "mic",
      command: "listen",
      args: { max_ms: 5000 },
      deadline_ms: 5000,
    });
    await tick(30);
    sock.receive({ t: "req", id: 51, op: "abort", of: 50 });
    for (let i = 0; i < 50 && !sock.json().some((m) => m.t === "res" && m.id === 50); i++) await tick(5);
    expect(sock.json().find((m) => m.t === "res" && m.id === 50)!.result.reason).toBe("preempted");
  });

  test("a close from the process ends the lending and says why", async () => {
    const { join, sock, page } = rig();
    await join();
    sock.closeFromServer(1001, "the process is ending");
    expect(page.kit.status()).toMatchObject({
      state: "closed",
      closed: { code: 1001, reason: "the process is ending" },
      rejoin: null,
    });
  });
});

describe("microphone", () => {
  test("phrases match with case, accents and spacing ignored, as a substring", () => {
    expect(norm("  Ya me  la TOMÉ ")).toBe("ya me la tome");
    expect(matchPhrase("Sí, ya me la tomé hoy", ["no", "ya me la tome"])).toBe("ya me la tome");
    expect(matchPhrase("Buenos días", ["ya me la tome", ""])).toBe("");
  });

  test("listen hears one phrase, matches expect and pushes last_match", async () => {
    const { join, req, browser, sock } = rig();
    await join();
    browser.hear({ transcript: "Ya me la TOMÉ", confidence: 0.92 });
    const { res } = await req({
      op: "command",
      device: "mic",
      command: "listen",
      args: { max_ms: 3000, expect: ["no", "ya me la tome"] },
      deadline_ms: 3000,
    });
    expect(res.result).toEqual({
      measured: { heard: true, transcript: "Ya me la TOMÉ", confidence: 0.92, match: "ya me la tome" },
      reason: "completed",
    });
    expect(browser.recognizers.at(-1)!.lang).toBe("es-ES");
    expect(browser.recognizers.at(-1)!.continuous).toBe(false);
    const states = sock.json().filter((m) => m.t === "state" && m.device === "mic");
    expect(states.some((m) => m.values.listening === true)).toBe(true);
    expect(states.at(-1)!.values).toEqual({ listening: false });
    expect(states.some((m) => m.values.last_match === "ya me la tome" && m.values.heard_count === 1)).toBe(true);
  });

  test("lang of the command wins over the page's", async () => {
    const { join, req, browser } = rig();
    await join();
    browser.hear({ transcript: "take it", confidence: 0.5 });
    await req({
      op: "command",
      device: "mic",
      command: "listen",
      args: { max_ms: 1000, lang: "en-GB" },
      deadline_ms: 1000,
    });
    expect(browser.recognizers.at(-1)!.lang).toBe("en-GB");
  });

  test("silence until max_ms ends with reason timeout, the recognizer started again meanwhile", async () => {
    const { join, req, browser } = rig();
    await join();
    browser.hear("silence");
    const { res } = await req(
      { op: "command", device: "mic", command: "listen", args: { max_ms: 800 }, deadline_ms: 800 },
      900,
    );
    expect(res.result).toEqual({
      measured: { heard: false, transcript: "", confidence: 0, match: "" },
      reason: "timeout",
    });
    expect(browser.recognizers.length).toBeGreaterThanOrEqual(2);
  });

  test("a recognizer error is the command's error", async () => {
    const { join, req, browser } = rig();
    await join();
    browser.hear({ error: "not-allowed" });
    const { res } = await req({
      op: "command",
      device: "mic",
      command: "listen",
      args: { max_ms: 1000 },
      deadline_ms: 1000,
    });
    expect(res.error.code).toBe("unsupported");
    browser.hear({ error: "network" });
    const net = await req({
      op: "command",
      device: "mic",
      command: "listen",
      args: { max_ms: 1000 },
      deadline_ms: 1000,
    });
    expect(net.res.error).toEqual({
      code: "timeout",
      message: "speech recognition: the browser's speech service could not be reached",
    });
  });

  test("level_pct is pushed from the worklet, at most 20 messages per second per device", async () => {
    const { join, sock, browser } = rig();
    await join();
    const before = sock.json().length;
    for (let i = 0; i < 30; i++) browser.level(i * 3);
    const states = sock
      .json()
      .slice(before)
      .filter((m) => m.t === "state" && m.device === "mic");
    expect(states.length).toBeLessThanOrEqual(20);
    expect(states[0]!.values).toEqual({ level_pct: 0 });
  });
});

describe("speaker", () => {
  test("speak uses the page's language by default, a named voice when asked, and counts what it said", async () => {
    const { join, req, browser, sock } = rig();
    await join();
    const a = await req({
      op: "command",
      device: "speaker",
      command: "speak",
      args: { text: "hola" },
      deadline_ms: 15000,
    });
    expect(a.res.result).toEqual({ measured: { spoken: true }, reason: "completed" });
    expect(browser.spoken.at(-1)!.voice!.name).toBe("Mónica");
    await req({
      op: "command",
      device: "speaker",
      command: "speak",
      args: { text: "hi", voice: "Samantha", rate_wpm: 360 },
      deadline_ms: 15000,
    });
    expect(browser.spoken.at(-1)!.voice!.name).toBe("Samantha");
    expect(browser.spoken.at(-1)!.rate).toBe(2);
    await req({
      op: "command",
      device: "speaker",
      command: "speak",
      args: { text: "hola", lang: "es-MX" },
      deadline_ms: 15000,
    });
    expect(browser.spoken.at(-1)!.voice!.name).toBe("Paulina");
    const last = sock
      .json()
      .filter((m) => m.t === "state" && m.device === "speaker" && "spoken_count" in m.values)
      .at(-1)!;
    expect(last.values).toEqual({ last_spoken: "hola", spoken_count: 3 });
  });

  test("voiceFor: exact tag, then base language, else none", () => {
    expect(voiceFor(VOICES, "es-ES")!.name).toBe("Mónica");
    expect(voiceFor(VOICES, "es-AR")!.name).toBe("Mónica");
    expect(voiceFor(VOICES, "fr-FR")).toBeNull();
  });

  test("tone plays and returns when it has ended", async () => {
    const { join, req } = rig();
    await join();
    const { res } = await req({
      op: "command",
      device: "speaker",
      command: "tone",
      args: { frequency_hz: 440, duration_ms: 20 },
      deadline_ms: 20,
    });
    expect(res.result).toEqual({ measured: { played: true }, reason: "completed" });
  });
});

describe("screen and buttons", () => {
  test("text, face, color and clear show on the page and in showing", async () => {
    const { join, req, views, sock } = rig();
    await join();
    await req({
      op: "command",
      device: "screen",
      command: "text",
      args: { lines: ["hola", "mundo"] },
      deadline_ms: 2000,
    });
    expect(views.at(-1)).toEqual({ t: "text", lines: ["hola", "mundo"] });
    await req({ op: "command", device: "screen", command: "face", args: { expression: "happy" }, deadline_ms: 2000 });
    expect(views.at(-1)).toMatchObject({ t: "face", name: "happy" });
    const bad = await req({
      op: "command",
      device: "screen",
      command: "color",
      args: { color: "red", ms: 500 },
      deadline_ms: 2000,
    });
    expect(bad.res.error.code).toBe("invalid_argument");
    await req({
      op: "command",
      device: "screen",
      command: "color",
      args: { color: "#FF0000", ms: 100 },
      deadline_ms: 2000,
    });
    expect(views.at(-1)).toEqual({ t: "color", color: "#ff0000" });
    await tick(150);
    expect(views.at(-1)).toMatchObject({ t: "face", name: "happy" });
    await req({ op: "command", device: "screen", command: "clear", args: {}, deadline_ms: 2000 });
    const shown = sock
      .json()
      .filter((m) => m.t === "state" && m.device === "screen")
      .map((m) => m.values.showing);
    expect(shown).toEqual(["face: neutral", "text: hola / mundo", "face: happy", "color: #ff0000", "face: happy", ""]);
  });

  test("buttons push a press, a release and a counter; set_labels draws only labelled buttons", async () => {
    const { join, sock, page, req, labels } = rig();
    await join();
    page.touch.press(1);
    page.touch.press(1); // a second pointerdown while down is the same press
    page.touch.release(1);
    const touch = sock
      .json()
      .filter((m) => m.t === "state" && m.device === "touch")
      .slice(1);
    expect(touch.map((m) => m.values)).toEqual([{ b2: true, b2_presses: 1 }, { b2: false }]);
    expect(labels()).toEqual(["1", "2", "3", "4"]);
    await req({
      op: "command",
      device: "touch",
      command: "set_labels",
      args: { labels: ["Sí", "No"] },
      deadline_ms: 2000,
    });
    expect(labels()).toEqual(["Sí", "No", "", ""]);
  });
});

describe("the extension API", () => {
  test("the door example, the file in deployments/example/page-ext and the docs' text alike, joins the manifest and pushes", async () => {
    const { join, page, sock } = rig();
    await join();
    const code = extFile("door.js");
    const doc = readFileSync(joinPath(REPO, "docs", "peripheral-pages.md"), "utf8");
    expect(doc.match(/```js door\.js\n([\s\S]*?)```/)![1]!).toBe(code);
    const { listeners } = runExtension(page.spinecord, code);
    const devices = sock
      .json()
      .filter((m) => m.t === "devices")
      .at(-1)!.devices as PageDevice[];
    expect(validatePageManifest(devices)).toEqual([]);
    expect(devices.find((d) => d.id === "door")).toMatchObject({ kind: "contact", roles: [] });
    listeners.pointerdown!();
    listeners.pointerup!();
    const door = sock.json().filter((m) => m.t === "state" && m.device === "door");
    expect(door.map((m) => m.values)).toEqual([
      { closed: false, opened_count: 0 },
      { closed: true },
      { closed: false, opened_count: 1 },
    ]);
  });

  test("the QR example: unavailable, with why, where the browser has no BarcodeDetector", async () => {
    const { join, page } = rig();
    runExtension(page.spinecord, extFile("qr.js"));
    const hello = await join();
    expect(ids(hello.devices)).not.toContain("qr");
    expect(hello.unavailable).toContainEqual({
      kind: "code_reader",
      why: "code_reader: this browser has no barcode detector (BarcodeDetector)",
    });
  });

  test("the QR example: scan reads a code from the lent camera's frames, closes each frame, and times out on none", async () => {
    const { join, page, req } = rig();
    const frames: { closed: boolean }[] = [];
    const seen = { codes: [] as { rawValue: string }[][] };
    const formats: string[][] = [];
    class BarcodeDetector {
      constructor(o: { formats: string[] }) {
        formats.push(o.formats);
      }
      async detect() {
        return seen.codes.shift() ?? [];
      }
    }
    // each frame is closed once detect has looked at it: cameraFrame is wrapped to see each bitmap's close
    const spinecord = {
      ...page.spinecord,
      cameraFrame: async () => {
        const b = await page.spinecord.cameraFrame();
        const f = { closed: false };
        frames.push(f);
        return { ...b, close: () => ((f.closed = true), b.close()) };
      },
    };
    runExtension(spinecord, extFile("qr.js"), { BarcodeDetector });
    const hello = await join();
    expect(validatePageManifest(hello.devices)).toEqual([]);
    expect(ids(hello.devices)).toContain("qr");
    seen.codes = [[], [{ rawValue: "https://example.org/r1" }]];
    const { res } = await req({
      op: "command",
      device: "qr",
      command: "scan",
      args: { max_ms: 2000 },
      deadline_ms: 4000,
    });
    expect(res.result).toEqual({ reason: "completed", measured: { found: true, text: "https://example.org/r1" } });
    expect(formats[0]).toEqual(["qr_code"]);
    expect(frames.length).toBe(2);
    expect(frames.every((f) => f.closed)).toBe(true);
    const read = await req({ op: "read", device: "qr", channels: ["last_text", "read_count"] });
    expect(read.res.readings).toEqual({ last_text: "https://example.org/r1", read_count: 1 });
    const none = await req(
      { op: "command", device: "qr", command: "scan", args: { max_ms: 300 }, deadline_ms: 2000 },
      400,
    );
    expect(none.res.result).toEqual({ reason: "timeout", measured: { found: false, text: "" } });
  });

  test("a screen an extension adds is a value of face", async () => {
    const { join, page, sock, req, views } = rig();
    await join();
    let drawn = 0;
    page.spinecord.screen("sleepy", () => void drawn++);
    const screen = (
      sock
        .json()
        .filter((m) => m.t === "devices")
        .at(-1)!.devices as PageDevice[]
    ).find((d) => d.id === "screen")!;
    const face = screen.commands.find((c) => c.name === "face")!.params.properties as Record<
      string,
      { enum: string[] }
    >;
    expect(face.expression!.enum).toContain("sleepy");
    await req({ op: "command", device: "screen", command: "face", args: { expression: "sleepy" }, deadline_ms: 2000 });
    expect(views.at(-1)).toMatchObject({ t: "face", name: "sleepy" });
  });

  test("a device whose run throws a PageError answers with its code; ended() gives another reason", async () => {
    const { join, page, req } = rig();
    await join();
    page.spinecord.device({
      id: "thing",
      kind: "thing",
      description: "A test device.",
      channels: [],
      commands: [
        {
          name: "go",
          description: "Goes.",
          params: { type: "object", properties: {}, additionalProperties: false },
          bound: { kind: "instant", max: 0 },
          moves: false,
        },
      ],
      run: (_c, args) => {
        if (args.fail) throw new page.spinecord.PageError("busy", "busy now");
        return page.spinecord.ended("timeout", { tries: 3 });
      },
    });
    expect((await req({ op: "command", device: "thing", command: "go", args: {}, deadline_ms: 1 })).res.result).toEqual(
      {
        measured: { tries: 3 },
        reason: "timeout",
      },
    );
    expect(
      (await req({ op: "command", device: "thing", command: "go", args: { fail: true }, deadline_ms: 1 })).res.error,
    ).toEqual({
      code: "busy",
      message: "busy now",
    });
  });

  test("push refuses a channel that is not pushed, and a value of the wrong type", async () => {
    const { page } = rig();
    expect(() => page.spinecord.push("touch", { b1: 3 })).toThrow("must be a boolean");
    expect(() => page.spinecord.push("screen", { nope: "x" })).toThrow("not a pushed channel");
    expect(() => page.spinecord.push("door", { x: 1 })).toThrow('no device "door"');
  });

  test("cameraFrame gives the lent camera's bitmap and rejects without one", async () => {
    const lent = rig();
    await lent.join();
    expect((await lent.page.spinecord.cameraFrame()).width).toBe(1280);
    const refused = rig({ camera: "NotAllowedError" });
    await refused.join();
    await expect(refused.page.spinecord.cameraFrame()).rejects.toThrow("no camera is lent");
  });

  test("fit keeps the aspect ratio under the longest side", () => {
    expect(fit(1280, 720, 640)).toEqual({ width: 640, height: 360 });
    expect(fit(480, 640, 1280)).toEqual({ width: 480, height: 640 });
  });
});

/** A phone's browser: motion sensors, vibration, a touch screen, a camera with a torch. */
const PHONE: FakeBrowserOptions = { motion: "events", vibrate: true, pointer: "coarse", torch: true };
const states = (sock: ReturnType<typeof fakeSocket>, device: string) =>
  sock
    .json()
    .filter((m) => m.t === "state" && m.device === device)
    .map((m) => m.values);

describe("the phone's kinds", () => {
  test("a phone lends the imu, the vibrator and the torch too, and the manifest passes the process's check", async () => {
    const hello = await rig(PHONE).join("phone");
    expect(validatePageManifest(hello.devices)).toEqual([]);
    expect(ids(hello.devices).sort()).toEqual([
      "camera",
      "imu",
      "mic",
      "screen",
      "speaker",
      "torch",
      "touch",
      "vibrator",
    ]);
    expect(hello.unavailable).toEqual([]);
    expect(chans(hello.devices, "imu")).toEqual([
      "pitch_deg",
      "roll_deg",
      "heading_deg",
      "accel_x_m_s2",
      "accel_y_m_s2",
      "accel_z_m_s2",
      "shaken",
      "rate_x_deg_s",
      "rate_y_deg_s",
      "rate_z_deg_s",
    ]);
    const imuSpec = hello.devices.find((d) => d.id === "imu")!;
    expect(imuSpec.channels.every((c) => c.pushed === true && c.max_rate_hz === 20)).toBe(true);
    expect(imuSpec.channels.find((c) => c.name === "heading_deg")!.null_when_absent).toBe(true);
    expect(cmds(hello.devices, "vibrator")).toEqual(["vibrate"]);
    expect(cmds(hello.devices, "torch")).toEqual(["set"]);
  });

  test("the motion permission is asked in the tap; denied, the imu is unavailable and the rest is lent", async () => {
    const { join, browser } = rig({ ...PHONE, motionPermission: "denied" });
    const hello = await join("phone");
    expect(browser.permissionAsks.sort()).toEqual(["motion", "orientation"]);
    expect(ids(hello.devices)).not.toContain("imu");
    expect(ids(hello.devices)).toContain("camera");
    expect(hello.unavailable).toEqual([{ kind: "imu", why: "imu: the person did not allow the motion sensors" }]);
  });

  test("the motion permission granted lends the imu", async () => {
    const hello = await rig({ ...PHONE, motionPermission: "granted" }).join("phone");
    expect(ids(hello.devices)).toContain("imu");
  });

  test("a browser with the motion events and no sensor behind them does not lend an imu; a late first sample does", async () => {
    const { join, browser, sock } = rig({ motion: "silent" });
    const hello = await join();
    expect(hello.unavailable.find((u) => u.kind === "imu")!.why).toBe(
      "imu: this device sent no motion sample: it has no motion sensors, or the browser gives the page none",
    );
    browser.orient({ alpha: 0, beta: 5, gamma: 0 });
    const devices = sock
      .json()
      .filter((m) => m.t === "devices")
      .at(-1)!;
    expect(chans(devices.devices, "imu")).toEqual(["pitch_deg", "roll_deg", "heading_deg"]);
    expect(validatePageManifest(devices.devices)).toEqual([]);
    expect(states(sock, "imu").at(-1)).toEqual({ pitch_deg: 5, roll_deg: 0, heading_deg: null });
  });

  test("imu values are pushed from the events: tilt, heading counter-clockwise from north, acceleration, shaken", async () => {
    const { join, browser, sock } = rig(PHONE);
    await join("phone");
    await tick(60);
    browser.orient({ alpha: 200, beta: 30.04, gamma: -10, absolute: false });
    expect(states(sock, "imu").at(-1)).toMatchObject({ pitch_deg: 30, roll_deg: -10 });
    await tick(60);
    browser.orient({ alpha: 90, beta: 31, gamma: -11 }, true); // deviceorientationabsolute: 90 = west
    expect(states(sock, "imu").at(-1)).toMatchObject({ pitch_deg: 31, heading_deg: 90 });
    await tick(60);
    browser.orient({ alpha: 200, beta: 32, gamma: -12, absolute: false }); // a relative sample keeps the heading
    expect(states(sock, "imu").at(-1)).toEqual({ pitch_deg: 32, roll_deg: -12 });
    await tick(60);
    browser.orient({ alpha: 0, beta: 0, gamma: 0, webkitCompassHeading: 90 }); // Safari: 90 clockwise = east
    expect(states(sock, "imu").at(-1)).toMatchObject({ heading_deg: -90 });
    await tick(60);
    browser.move({
      acceleration: { x: 20, y: 0, z: 0 },
      accelerationIncludingGravity: { x: 20, y: 0, z: 9.81 },
      rotationRate: { alpha: 45, beta: 1, gamma: 2 },
    });
    expect(states(sock, "imu").at(-1)).toEqual({
      accel_x_m_s2: 20,
      accel_y_m_s2: 0,
      accel_z_m_s2: 9.81,
      shaken: true,
      rate_x_deg_s: 1,
      rate_y_deg_s: 2,
      rate_z_deg_s: 45,
    });
  });

  test("the imu pushes at most once per 50 ms, the latest values merged", async () => {
    const { join, browser, sock } = rig(PHONE);
    await join("phone");
    await tick(60);
    const before = states(sock, "imu").length;
    for (let i = 0; i < 30; i++) browser.orient({ alpha: 0, beta: i, gamma: 0 });
    expect(states(sock, "imu").length - before).toBe(1);
    await tick(60);
    browser.move({ accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 }, rotationRate: null });
    const last = states(sock, "imu").at(-1)!;
    expect(last).toMatchObject({ pitch_deg: 29, accel_z_m_s2: 9.8 });
  });

  test("vibrate vibrates for ms and returns; stop ends it", async () => {
    const { join, req, browser } = rig(PHONE);
    await join("phone");
    const { res } = await req({
      op: "command",
      device: "vibrator",
      command: "vibrate",
      args: { ms: 30 },
      deadline_ms: 30,
    });
    expect(res.result).toEqual({ measured: { vibrated_ms: 30 }, reason: "completed" });
    expect(browser.vibrations).toEqual([30]);
    const long = req({ op: "command", device: "vibrator", command: "vibrate", args: { ms: 2000 }, deadline_ms: 2000 });
    await tick(20);
    await req({ op: "stop" });
    expect((await long).res.result.reason).toBe("preempted");
    expect(browser.vibrations).toEqual([30, 2000, 0]);
  });

  test("a computer's browser with navigator.vibrate lends no vibrator", async () => {
    const hello = await rig({ vibrate: true }).join();
    expect(hello.unavailable.find((u) => u.kind === "vibrator")!.why).toBe(
      "vibrator: this is not a phone or tablet: its browser can vibrate nothing",
    );
  });

  test("the torch goes on through the camera track's constraint, and off by itself after ms and at stop", async () => {
    const { join, req, browser, sock } = rig(PHONE);
    await join("phone");
    const on = await req({
      op: "command",
      device: "torch",
      command: "set",
      args: { on: true, ms: 100 },
      deadline_ms: 100,
    });
    expect(on.res.result).toEqual({ measured: { on: true }, reason: "completed" });
    expect(browser.video.torchOn).toBe(true);
    expect(states(sock, "torch").at(-1)).toEqual({ on: true });
    await tick(150);
    expect(browser.video.torchOn).toBe(false);
    expect(states(sock, "torch").at(-1)).toEqual({ on: false });
    await req({ op: "command", device: "torch", command: "set", args: { on: true }, deadline_ms: 30000 });
    expect(browser.video.torchOn).toBe(true);
    await req({ op: "stop" });
    expect(browser.video.torchOn).toBe(false);
    expect(states(sock, "torch").at(-1)).toEqual({ on: false });
    expect(browser.video.constraints).toEqual([
      { advanced: [{ torch: true }] },
      { advanced: [{ torch: false }] },
      { advanced: [{ torch: true }] },
      { advanced: [{ torch: false }] },
    ]);
  });

  test("the torch follows the camera: stop lending takes it out", async () => {
    const { join, page, sock } = rig(PHONE);
    await join("phone");
    page.stopLending();
    const devices = sock
      .json()
      .filter((m) => m.t === "devices")
      .at(-1)!;
    expect(ids(devices.devices).sort()).toEqual(["screen", "speaker", "touch", "vibrator"]);
    expect(devices.unavailable.map((u: { kind: string }) => u.kind).sort()).toEqual([
      "camera",
      "imu",
      "microphone",
      "torch",
    ]);
    expect(devices.unavailable.find((u: { kind: string }) => u.kind === "torch").why).toBe(
      "torch: the camera is not lent",
    );
  });
});

describe("sleep and waking up", () => {
  test("the wake lock is taken in the tap and asked again each time the page is visible again", async () => {
    const { join, browser, page, setVisible } = rig(PHONE);
    await join("phone");
    expect(browser.wake.requests).toBe(1);
    await tick(1);
    expect(page.wake()).toEqual({ t: "held" });
    // a browser releases the lock when the page is hidden
    setVisible(false);
    browser.wake.sentinels[0]!.fireRelease();
    await tick(1);
    expect(page.wake()).toEqual({ t: "none" });
    expect(browser.wake.requests).toBe(1);
    setVisible(true);
    expect(browser.wake.requests).toBe(2);
    await tick(1);
    expect(page.wake()).toEqual({ t: "held" });
  });

  test("a refused wake lock is said, not swallowed", async () => {
    const { join, page } = rig({ wakeLock: "denied" });
    await join();
    await tick(1);
    expect(page.wake()).toMatchObject({ t: "refused" });
    expect((page.wake() as { why: string }).why).toContain("the browser refused to keep the screen on");
  });

  test("the lock is released when the page stops lending", async () => {
    const { join, browser, sock } = rig();
    await join();
    await tick(1);
    sock.closeFromServer(1001, "the process ended");
    await tick(1);
    expect(browser.wake.sentinels[0]!.released).toBe(true);
  });

  test("a hidden page's imu is down, and up when the page is visible again", async () => {
    const { join, sock, setVisible } = rig(PHONE);
    await join("phone");
    setVisible(false);
    expect(sock.json().at(-1)).toEqual({
      t: "down",
      device: "imu",
      why: "the page is hidden: the browser sends it no motion events",
    });
    setVisible(true);
    expect(sock.json().some((m) => m.t === "up" && m.device === "imu")).toBe(true);
  });

  test("a camera track the browser ended while hidden is asked for again when the page is visible", async () => {
    const { join, sock, browser, setVisible, req } = rig(PHONE);
    await join("phone");
    const first = browser.video;
    setVisible(false);
    first.end();
    expect(sock.json().at(-1)).toEqual({ t: "down", device: "camera", why: "the camera was turned off or unplugged" });
    setVisible(true);
    await tick(5);
    expect(browser.video).not.toBe(first);
    expect(sock.json().filter((m) => m.t === "up" && m.device === "camera").length).toBe(1);
    const { res } = await req({ op: "read", device: "camera", channels: ["width_px"] });
    expect(res.ok).toBe(true);
    // the old track's events say nothing any more
    first.fire("mute");
    expect(sock.json().at(-1)).not.toMatchObject({ t: "down", device: "camera" });
  });

  test("a camera another program holds when the page is visible again stays down, with why", async () => {
    const { join, sock, browser, setVisible } = rig(PHONE);
    await join("phone");
    browser.video.end();
    browser.refuseAgain("NotReadableError");
    setVisible(true);
    await tick(5);
    expect(sock.json().at(-1)).toEqual({
      t: "down",
      device: "camera",
      why: "the page could not get the camera back: another program holds the camera",
    });
  });

  test("a camera whose permission the browser took back leaves the manifest for unavailable, with why", async () => {
    const { join, sock, browser, setVisible, page } = rig(PHONE);
    await join("phone");
    const track = browser.video;
    track.end();
    browser.refuseAgain();
    setVisible(true);
    await tick(5);
    const last = sock.json().at(-1)!;
    expect(last.t).toBe("devices");
    expect(ids(last.devices)).not.toContain("camera");
    expect(last.unavailable).toContainEqual({
      kind: "camera",
      why: "camera: the page could not get the camera back: the person did not allow it; reload the page and tap Lend this device to lend it again",
    });
    expect(page.live().camera).toBeNull();
    expect(track.stopped).toBe(true);
  });

  test("a permission the browser says is gone is never asked for outside the tap", async () => {
    const { join, sock, browser, setVisible } = rig({ ...PHONE, permissions: true });
    await join("phone");
    browser.video.end();
    browser.audioTrack.end();
    browser.permission("camera", "denied");
    browser.permission("microphone", "prompt");
    const asked = browser.asked.length;
    setVisible(true);
    await tick(5);
    // no getUserMedia: no prompt the person did not tap for
    expect(browser.asked.length).toBe(asked);
    expect(browser.permissionAsks).toEqual(expect.arrayContaining(["query camera", "query microphone"]));
    const last = sock
      .json()
      .filter((m) => m.t === "devices")
      .at(-1)!;
    expect(ids(last.devices)).not.toContain("camera");
    expect(ids(last.devices)).not.toContain("mic");
    expect(last.unavailable).toEqual(
      expect.arrayContaining([
        {
          kind: "camera",
          why: "camera: the page could not get the camera back: the browser took back the permission for the camera; reload the page and tap Lend this device to lend it again",
        },
        {
          kind: "microphone",
          why: "microphone: the page could not get the microphone back: the browser would ask the person for the microphone again, and the page asks only in the tap; reload the page and tap Lend this device to lend it again",
        },
      ]),
    );
  });

  test("a permission still granted is taken back without a prompt", async () => {
    const { join, sock, browser, setVisible } = rig({ ...PHONE, permissions: true });
    await join("phone");
    const first = browser.video;
    first.end();
    setVisible(true);
    await tick(5);
    expect(browser.video).not.toBe(first);
    expect(sock.json().filter((m) => m.t === "up" && m.device === "camera").length).toBe(1);
  });

  test("a muted microphone track is down, unmuted it is up; ended, it is asked for again", async () => {
    const { join, sock, browser, setVisible } = rig();
    await join();
    browser.audioTrack.fire("mute");
    expect(sock.json().at(-1)).toEqual({ t: "down", device: "mic", why: "the microphone stopped sending sound" });
    browser.audioTrack.fire("unmute");
    expect(sock.json().at(-1)).toEqual({ t: "up", device: "mic" });
    const first = browser.audioTrack;
    first.end();
    setVisible(true);
    await tick(5);
    expect(browser.audioTrack).not.toBe(first);
    expect(sock.json().at(-1)).toEqual({ t: "up", device: "mic" });
  });
});
