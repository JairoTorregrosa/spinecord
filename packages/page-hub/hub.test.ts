// The hub against a fake page socket and a hand-moved clock: what each page state answers, requests and their
// deadlines, frames and their limits, stop. The page state machine itself is apps/local's (its tests drive it).
import { describe, expect, test } from "bun:test";
import { RuntimeError, type PageDevice, type ServerToPage } from "../protocol/types";
import { PAGE_LIMITS, PageHub } from "./hub";
import { imageSize } from "./image";

const touch: PageDevice = {
  id: "touch",
  kind: "touch_panel",
  roles: ["touch"],
  description: "Buttons on the screen.",
  channels: [
    { name: "b1", type: "boolean", pushed: true, description: "A finger is on button 1." },
    { name: "b1_presses", type: "number", pushed: true, description: "Presses of button 1." },
  ],
  commands: [],
};
const camera: PageDevice = {
  id: "camera",
  kind: "camera",
  roles: ["eyes"],
  description: "A camera.",
  channels: [
    { name: "frame", type: "image", description: "One frame per read." },
    { name: "width_px", type: "number", description: "Width." },
  ],
  commands: [],
};
const speaker: PageDevice = {
  id: "speaker",
  kind: "speaker",
  roles: ["voice"],
  description: "A voice.",
  channels: [],
  commands: [
    {
      name: "speak",
      description: "Says a text.",
      params: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false },
      bound: { kind: "ms", max: 50 },
      moves: false,
    },
  ],
};

/** A JPEG header with a frame of w × h: SOI, then a baseline SOF0. */
export function jpeg(w: number, h: number, pad = 0): Uint8Array {
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
    ...new Array(12 + pad).fill(0),
  ]);
}

function rig() {
  let t = 1000;
  const sent: ServerToPage[] = [];
  const hub = new PageHub({ now: () => t, limits: { read_ms: 40, command_margin_ms: 40, stop_wait_ms: 40 } });
  let changes = 0;
  hub.onDevicesChanged(() => changes++);
  const link = hub.join("desk", { send: (m) => void sent.push(m) }, [touch, camera, speaker], []);
  link.setState("active", null);
  const reqs = () => sent.filter((m): m is Extract<ServerToPage, { t: "req" }> => m.t === "req");
  return { hub, link, sent, reqs, advance: (ms: number) => void (t += ms), changes: () => changes };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as RuntimeError;
  }
  throw new Error("expected an error");
};

describe("PageHub", () => {
  test("devices are <page>.<local>, the page is their provider, and a join or a removal asks for a scan", async () => {
    const r = rig();
    expect(r.changes()).toBe(1); // the join
    const ids = (await r.hub.devices()).map((d) => [d.id, d.provider]);
    expect(ids).toEqual([
      ["desk.touch", "desk"],
      ["desk.camera", "desk"],
      ["desk.speaker", "desk"],
    ]);
    r.hub.remove("desk");
    expect(r.changes()).toBe(2);
    expect(await r.hub.devices()).toEqual([]);
    expect((await code(r.hub.read("desk.touch", ["b1"]))).code).toBe("unknown_device");
    expect(r.hub.backend).toBe("page");
    expect(r.hub.stop_worst_ms).toBe(350);
  });

  test("a pushed channel reads its latest value, with its ts; before the first push it has none", async () => {
    const r = rig();
    const [before] = await r.hub.read("desk.touch", ["b1"]);
    expect(before).toMatchObject({ value: null, error: "the page has not reported this channel yet" });
    expect(r.link.receive({ t: "state", device: "touch", values: { b1: true, b1_presses: 1 } })).toBeNull();
    r.advance(5);
    expect(await r.hub.read("desk.touch", ["b1", "b1_presses"])).toEqual([
      { device: "desk.touch", channel: "b1", value: true, ts: 1000 },
      { device: "desk.touch", channel: "b1_presses", value: 1, ts: 1000 },
    ]);
    expect(r.reqs()).toEqual([]); // no round trip
    expect(r.link.watched()).toBe(true);
    // a push of the wrong type, or of a channel that is not pushed, breaks the protocol
    expect(r.link.receive({ t: "state", device: "touch", values: { b1: 1 } })).toContain("boolean");
    expect(r.link.receive({ t: "state", device: "camera", values: { width_px: 1 } })).toContain("not a pushed");
  });

  test("a ping unanswered for 300 ms makes pushed values no answer, with the device_offline reason", async () => {
    const r = rig();
    r.link.receive({ t: "state", device: "touch", values: { b1: false } });
    r.link.ping();
    r.advance(PAGE_LIMITS.stale_ms - 1);
    expect((await r.hub.read("desk.touch", ["b1"]))[0]!.value).toBe(false);
    r.advance(1);
    const [stale] = await r.hub.read("desk.touch", ["b1"]);
    expect(stale!.value).toBeNull();
    expect(stale!.error).toStartWith("device_offline: the page named desk has not answered a ping for 300 ms");
    r.link.receive({ t: "pong", n: 1 });
    expect((await r.hub.read("desk.touch", ["b1"]))[0]!.value).toBe(false);
    expect(r.link.silentMs()).toBe(0);
  });

  test("silence: none while no ping waits; the first ping after a quiet second has 200 ms for its answer", async () => {
    const r = rig();
    r.link.ping();
    r.link.receive({ t: "pong", n: 1 });
    r.advance(1000); // a quiet second: no ping waits, nothing is silent
    expect(r.link.silentMs()).toBe(0);
    r.link.ping();
    r.advance(PAGE_LIMITS.stale_ms - PAGE_LIMITS.answer_ms - 1);
    expect(r.link.silentMs()).toBe(PAGE_LIMITS.stale_ms - 1);
    r.advance(1);
    expect(r.link.silentMs()).toBe(PAGE_LIMITS.stale_ms);
    r.link.receive({ t: "pong", n: 2 });
    // in a watch, a ping every 100 ms: silence counts from the last answer
    r.advance(100);
    r.link.ping();
    r.advance(200);
    expect(r.link.silentMs()).toBe(300);
  });

  test("an asleep page, or a device that is down, throws device_offline: retryable, after 2000 ms, describe_robot first", async () => {
    const r = rig();
    r.link.paused = true;
    r.link.setState("asleep", "was paused by the person at the page");
    const e = await code(r.hub.read("desk.touch", ["b1"]));
    expect(e).toMatchObject({
      code: "device_offline",
      retryable: true,
      retry_after_ms: 2000,
      next: ["describe_robot"],
    });
    expect(e.message).toContain("was paused");
    expect(e.message).toContain("resume");
    r.link.paused = false;
    r.link.setState("active", null);
    r.link.receive({ t: "state", device: "touch", values: { b1: true } });
    expect(r.link.receive({ t: "down", device: "camera", why: "its camera track ended" })).toBeNull();
    const down = await code(r.hub.read("desk.camera", ["frame"]));
    expect(down.code).toBe("device_offline");
    expect(down.message).toContain("desk.camera is down: its camera track ended");
    // the page's other devices work
    expect((await r.hub.read("desk.touch", ["b1"]))[0]!.value).toBe(true);
    r.link.receive({ t: "up", device: "camera" });
    const read = r.hub.read("desk.camera", ["width_px"]);
    const req = r.reqs().at(-1)!;
    r.link.receive({ t: "res", id: req.id, ok: true, readings: { width_px: 640 } });
    expect((await read)[0]).toMatchObject({ value: 640 });
  });

  test("a frame: the res, then its bytes; one too large is frame_too_large; a third in one second is busy", async () => {
    const r = rig();
    const read = (bytes: Uint8Array) => {
      const p = r.hub.read("desk.camera", ["frame"]);
      const req = r.reqs().at(-1)!;
      expect(req).toMatchObject({ op: "read", device: "camera", channels: ["frame"] });
      r.link.receive({
        t: "res",
        id: req.id,
        ok: true,
        image: { channel: "frame", mime: "image/jpeg", bytes: bytes.length, age_ms: 30 },
      });
      expect(r.link.binary(bytes)).toBeNull();
      return p;
    };
    const [ok] = await read(jpeg(640, 480));
    expect(ok!.image).toEqual({ mime: "image/jpeg", b64: Buffer.from(jpeg(640, 480)).toString("base64"), age_ms: 30 });
    expect(ok!.ts).toBe(1000 - 30);
    const [big] = await read(jpeg(1281, 720));
    expect(big).toMatchObject({ value: null, error: "frame_too_large" });
    expect((await code(r.hub.read("desk.camera", ["frame"]))).code).toBe("busy");
    r.advance(1000);
    const [heavy] = await read(jpeg(100, 100, PAGE_LIMITS.max_frame_bytes));
    expect(heavy).toMatchObject({ error: "frame_too_large" });
    expect(r.link.binary(new Uint8Array(3))).toContain("no image res");
  });

  test("a read the page does not answer in time is device_offline", async () => {
    const r = rig();
    const e = await code(r.hub.read("desk.camera", ["width_px"]));
    expect(e.code).toBe("device_offline");
    expect(e.message).toContain("did not answer a read");
  });

  test("a command: one at a time per device; the page's result; an abort is preempted at once and told to the page", async () => {
    const r = rig();
    const run = r.hub.command("desk.speaker", "speak", { text: "hi" }, new AbortController().signal);
    const req = r.reqs().at(-1)! as Extract<ServerToPage, { op: "command" }>;
    expect(req).toMatchObject({
      op: "command",
      device: "speaker",
      command: "speak",
      args: { text: "hi" },
      deadline_ms: 50,
    });
    expect((await code(r.hub.command("desk.speaker", "speak", { text: "x" }, new AbortController().signal))).code).toBe(
      "busy",
    );
    r.link.receive({ t: "res", id: req.id, ok: true, result: { measured: { spoken: true }, reason: "completed" } });
    expect(await run).toMatchObject({
      requested: { text: "hi" },
      measured: { spoken: true },
      reason: "completed",
      clamped: false,
    });

    const ctl = new AbortController();
    const cut = r.hub.command("desk.speaker", "speak", { text: "long" }, ctl.signal);
    const second = r.reqs().at(-1)!;
    ctl.abort();
    expect(await cut).toMatchObject({ reason: "preempted", measured: {} });
    expect(r.reqs().at(-1)).toMatchObject({ op: "abort", of: second.id });
    // the late answer is dropped
    expect(
      r.link.receive({ t: "res", id: second.id, ok: true, result: { measured: {}, reason: "completed" } }),
    ).toBeNull();
  });

  test("a command in flight on a page that falls asleep ends with device_offline; speak says the phrase may be cut", async () => {
    const r = rig();
    const run = r.hub.command("desk.speaker", "speak", { text: "hi" }, new AbortController().signal);
    r.link.setState("asleep", "did not answer a ping for 3000 ms");
    const e = await code(run);
    expect(e.code).toBe("device_offline");
    expect(e.message).toContain("The phrase may have been cut.");
  });

  test("a command the page never answers is device_offline after its bound + the margin", async () => {
    const r = rig();
    const t0 = performance.now();
    const e = await code(r.hub.command("desk.speaker", "speak", { text: "hi" }, new AbortController().signal));
    expect(e.code).toBe("device_offline");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(80);
  });

  test("stop asks every page to end its commands, waits at most stop_wait_ms, and is verified", async () => {
    const r = rig();
    const t0 = performance.now();
    expect(await r.hub.stop()).toEqual({ motors_stopped: true });
    expect(performance.now() - t0).toBeLessThan(PAGE_LIMITS.stop_wait_ms);
    expect(r.reqs().at(-1)).toMatchObject({ op: "stop" });
    // an asleep page is not asked
    r.link.setState("asleep", "x");
    const before = r.reqs().length;
    expect(await r.hub.stop()).toEqual({ motors_stopped: true });
    expect(r.reqs().length).toBe(before);
  });

  test("a new manifest drops the cached value of a channel it removes or retypes, and keeps the others", async () => {
    const r = rig();
    r.link.receive({ t: "state", device: "touch", values: { b1: true, b1_presses: 3 } });
    const retyped: PageDevice = {
      ...touch,
      channels: [{ ...touch.channels[0]!, type: "number" }, touch.channels[1]!],
    };
    r.link.setDevices([retyped], []);
    const [b1, presses] = await r.hub.read("desk.touch", ["b1", "b1_presses"]);
    expect(b1).toMatchObject({ value: null, error: "the page has not reported this channel yet" });
    expect(presses).toMatchObject({ value: 3 });
    r.link.setDevices([{ ...touch, channels: [touch.channels[0]!] }], []);
    r.link.setDevices([touch], []);
    expect((await r.hub.read("desk.touch", ["b1_presses"]))[0]).toMatchObject({ value: null });
  });

  test("a closed page ends its requests; a page that joins under its name takes its place", async () => {
    const r = rig();
    const read = r.hub.read("desk.camera", ["width_px"]);
    r.link.closed();
    expect((await code(read)).message).toContain("closed its connection");
    expect(() => r.hub.join("desk", { send() {} }, [touch], [])).not.toThrow();
    expect((await r.hub.devices()).map((d) => d.id)).toEqual(["desk.touch"]);
    expect(() => r.hub.join("desk", { send() {} }, [touch], [])).toThrow("already open");
  });
});

describe("values the page answers", () => {
  const beacon: PageDevice = {
    id: "beacon",
    kind: "beacon",
    roles: [],
    description: "Something that may be out of view.",
    channels: [
      { name: "seen", type: "number", pushed: true, null_when_absent: true, description: "Distance, null when none." },
      { name: "far", type: "number", null_when_absent: true, description: "Read on request, null when none." },
      { name: "level", type: "number", description: "A number read on request." },
    ],
    commands: [],
  };
  const make = () => {
    const sent: ServerToPage[] = [];
    const hub = new PageHub({ limits: { read_ms: 40 } });
    const link = hub.join("desk", { send: (m) => void sent.push(m) }, [beacon], []);
    link.setState("active", null);
    return { hub, link, last: () => sent.at(-1) as Extract<ServerToPage, { t: "req" }> };
  };
  test("null on a null_when_absent channel is an answer (absent: true), pushed or requested", async () => {
    const r = make();
    expect(r.link.receive({ t: "state", device: "beacon", values: { seen: null } })).toBeNull();
    expect((await r.hub.read("desk.beacon", ["seen"]))[0]).toMatchObject({ value: null, absent: true });
    const read = r.hub.read("desk.beacon", ["far"]);
    r.link.receive({ t: "res", id: r.last().id, ok: true, readings: { far: null } });
    expect((await read)[0]).toMatchObject({ value: null, absent: true });
    expect((await read)[0]!.error).toBeUndefined();
  });
  test("a requested value of the wrong type is a failed read; a pushed one breaks the protocol", async () => {
    const r = make();
    const read = r.hub.read("desk.beacon", ["level"]);
    r.link.receive({ t: "res", id: r.last().id, ok: true, readings: { level: "high" } });
    expect((await read)[0]).toMatchObject({ value: null, error: "the page returned a value that is not a number" });
    expect(r.link.receive({ t: "state", device: "beacon", values: { seen: "near" } })).toContain(
      "must be a number or null",
    );
  });
});

describe("imageSize", () => {
  test("reads a JPEG frame header and a PNG IHDR", () => {
    expect(imageSize(jpeg(320, 240), "image/jpeg")).toEqual({ width: 320, height: 240 });
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0, 0, 0, 1, 0,
    ]);
    expect(imageSize(png, "image/png")).toEqual({ width: 512, height: 256 });
    expect(imageSize(new Uint8Array([1, 2, 3, 4]), "image/jpeg")).toBeNull();
  });
});
