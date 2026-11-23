// A fake peripheral page: a bun WebSocket client that speaks CONTRACT §2.4 the way a page in a browser does.
// It takes the token from the page the server serves, sends its hello with a camera, a microphone, a speaker
// and touch buttons, answers pings from its message handler (no timer of its own), answers reads and commands,
// and pushes its buttons. A test makes it press a button, fall silent, pause, report a device down, or close.
import type { PageDevice, PageToServer, ServerToPage } from "../../../packages/protocol/types";

/** A small JPEG frame header of w × h (SOI + SOF0): enough for the server's size check, nothing to decode. */
export function testJpeg(w = 64, h = 48): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    h >> 8,
    h & 0xff,
    w >> 8,
    w & 0xff,
    ...new Array(12).fill(0),
  ]);
}

const closedObject = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

/** The devices of the fake: kinds and channels of CONTRACT §2.3. */
export const FAKE_DEVICES: PageDevice[] = [
  {
    id: "camera",
    kind: "camera",
    roles: ["eyes"],
    description: "The camera of this test page: one JPEG frame per read.",
    channels: [
      { name: "frame", type: "image", description: "One frame, taken when a read asks for it." },
      { name: "width_px", type: "number", unit: "px", description: "Width of the frames." },
    ],
    commands: [
      {
        name: "configure",
        description: "Sets the size of the next frames.",
        params: closedObject({ max_side_px: { type: "integer", minimum: 160, maximum: 1280 } }),
        bound: { kind: "instant", max: 0 },
        moves: false,
      },
    ],
  },
  {
    id: "mic",
    kind: "microphone",
    roles: ["ears"],
    description: "The microphone of this test page; recognition is scripted.",
    channels: [
      { name: "last_transcript", type: "string", pushed: true, description: "The latest phrase heard." },
      { name: "last_match", type: "string", pushed: true, description: "The expected phrase it matched." },
    ],
    commands: [
      {
        name: "listen",
        description: "Waits for one phrase, at most max_ms.",
        params: closedObject(
          {
            max_ms: { type: "integer", minimum: 500, maximum: 15000 },
            expect: { type: "array", items: { type: "string" }, maxItems: 8 },
          },
          ["max_ms"],
        ),
        bound: { kind: "ms", params: ["max_ms"], max: 15000 },
        moves: false,
      },
    ],
  },
  {
    id: "speaker",
    kind: "speaker",
    roles: ["voice"],
    description: "The voice of this test page; it records what it is told to say.",
    channels: [{ name: "spoken_count", type: "number", pushed: true, description: "Texts said since joining." }],
    commands: [
      {
        name: "speak",
        description: "Says a text and returns when it has been said.",
        params: closedObject({ text: { type: "string", maxLength: 300 } }, ["text"]),
        bound: { kind: "ms", max: 15000 },
        moves: false,
      },
    ],
  },
  {
    id: "touch",
    kind: "touch_panel",
    roles: ["touch"],
    description: "Buttons on the screen of this test page.",
    channels: [
      { name: "b1", type: "boolean", pushed: true, description: "A finger is on button 1." },
      { name: "b1_presses", type: "number", pushed: true, description: "Presses of button 1 since joining." },
    ],
    commands: [],
  },
];

export interface FakePageOptions {
  /** The page's address, as list_robots' join names it: http://127.0.0.1:<port>/ */
  url: string;
  robot?: string;
  name?: string;
  devices?: PageDevice[];
  /** Overrides the token the served page carries. */
  token?: string;
  /** The Origin header of the socket; default the listener's own. */
  origin?: string;
  /** What `listen` hears. */
  transcript?: string;
  frame?: Uint8Array;
}

export interface FakePage {
  /** Resolves with the welcome, or rejects with the close code and reason. */
  joined: Promise<Extract<ServerToPage, { t: "welcome" }>>;
  /** Resolves when the socket closed: the code and the reason the server gave. */
  closed: Promise<{ code: number; reason: string }>;
  spoken: string[];
  received: ServerToPage[];
  press(): void;
  release(): void;
  /** Stops answering pings, reads and commands (a locked phone, a frozen tab). */
  silence(): void;
  pause(): void;
  resume(): void;
  down(device: string, why: string): void;
  /** Sends a text message as it is. */
  raw(text: string): void;
  up(device: string): void;
  close(): void;
}

/** The token a page gets from the server: the meta tag of the page it serves. */
export async function servedToken(url: string): Promise<string> {
  const html = await (await fetch(url)).text();
  const m = html.match(/<meta name="spinecord-token" content="([^"]+)">/);
  if (!m) throw new Error(`no token in the page served at ${url}`);
  return m[1]!;
}

export async function fakePage(o: FakePageOptions): Promise<FakePage> {
  const base = new URL(o.url);
  const token = o.token ?? (await servedToken(o.url));
  const ws = new WebSocket(`ws://${base.host}/page`, {
    headers: { Origin: o.origin ?? `http://${base.host}` },
  } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  const devices = o.devices ?? FAKE_DEVICES;
  const received: ServerToPage[] = [];
  const spoken: string[] = [];
  let silent = false;
  let presses = 0;
  const send = (m: PageToServer) => ws.send(JSON.stringify(m));
  let onWelcome!: (w: Extract<ServerToPage, { t: "welcome" }>) => void;
  let onRefused!: (e: Error) => void;
  const joined = new Promise<Extract<ServerToPage, { t: "welcome" }>>((resolve, reject) => {
    onWelcome = resolve;
    onRefused = reject;
  });
  joined.catch(() => {});
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (e) => {
      onRefused(new Error(`closed ${e.code}: ${e.reason}`));
      resolve({ code: e.code, reason: e.reason });
    });
  });
  ws.addEventListener("open", () =>
    send({
      t: "hello",
      v: 1,
      token,
      ...(o.robot ? { robot: o.robot } : {}),
      name: o.name ?? "desk",
      devices,
      unavailable: [{ kind: "vibrator", why: "this browser has no vibration" }],
    }),
  );
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    const m = JSON.parse(ev.data) as ServerToPage;
    received.push(m);
    if (m.t === "welcome") {
      send({ t: "state", device: "touch", values: { b1: false, b1_presses: 0 } });
      send({ t: "state", device: "speaker", values: { spoken_count: 0 } });
      return onWelcome(m);
    }
    if (silent) return;
    if (m.t === "ping") return send({ t: "pong", n: m.n, visible: true });
    if (m.t !== "req") return;
    if (m.op === "stop") return send({ t: "res", id: m.id, ok: true });
    if (m.op === "abort") return;
    if (m.op === "read") {
      if (m.device === "camera" && m.channels.includes("frame")) {
        const frame = o.frame ?? testJpeg();
        send({
          t: "res",
          id: m.id,
          ok: true,
          readings: { width_px: 64 },
          image: { channel: "frame", mime: "image/jpeg", bytes: frame.length, age_ms: 20 },
        });
        return ws.send(frame as Uint8Array<ArrayBuffer>);
      }
      return send({ t: "res", id: m.id, ok: true, readings: m.device === "camera" ? { width_px: 64 } : {} });
    }
    // a command
    if (m.command === "speak") {
      spoken.push(String(m.args.text));
      send({ t: "state", device: "speaker", values: { spoken_count: spoken.length } });
      return send({ t: "res", id: m.id, ok: true, result: { measured: { spoken: true }, reason: "completed" } });
    }
    if (m.command === "listen") {
      const transcript = o.transcript ?? "";
      const expect = Array.isArray(m.args.expect) ? (m.args.expect as string[]) : [];
      const match = expect.find((p) => transcript.toLowerCase().includes(p.toLowerCase())) ?? "";
      // answered from the message handler too: the phrase was "heard" while the request was on its way
      send({ t: "state", device: "mic", values: { last_transcript: transcript, last_match: match } });
      return send({
        t: "res",
        id: m.id,
        ok: true,
        result: { measured: { heard: transcript !== "", transcript, confidence: 0.9, match }, reason: "completed" },
      });
    }
    if (m.command === "configure")
      return send({ t: "res", id: m.id, ok: true, result: { measured: {}, reason: "completed" } });
    send({ t: "res", id: m.id, ok: false, error: { code: "unknown_command", message: `no ${m.command}` } });
  });
  return {
    joined,
    closed,
    spoken,
    received,
    press() {
      send({ t: "state", device: "touch", values: { b1: true, b1_presses: ++presses } });
    },
    release() {
      send({ t: "state", device: "touch", values: { b1: false } });
    },
    silence() {
      silent = true;
    },
    pause() {
      send({ t: "paused", why: "test" });
    },
    resume() {
      send({ t: "resumed" });
    },
    down(device, why) {
      send({ t: "down", device, why });
    },
    up(device) {
      send({ t: "up", device });
    },
    raw(text) {
      ws.send(text);
    },
    close() {
      ws.close();
    },
  };
}
