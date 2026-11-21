// Test doubles for the two ends of the page: a WebHID device backed by the driver's FakeEV3 (so the real
// WebHIDTransport and Ev3Provider run), and a relay that speaks the /ws/robot wire protocol on localhost.
import { USB_PID, USB_VID } from "../../../packages/driver-ev3/encode";
import { FakeEV3 } from "../../../packages/driver-ev3/fake";
import type { HidDeviceLike } from "../../../packages/driver-ev3/transport";
import type { RelayToRuntime, RuntimeToRelay } from "../../../packages/protocol/types";
import type { PageConfig, RobotConfig } from "../src/config";
import type { HidApi } from "../src/session";

type ReportListener = (ev: { data: DataView }) => void;
type PlugListener = (ev: { device: HidDeviceLike }) => void;

/** An EV3 as Chrome exposes it: 1024-byte reports, every output report answered by the fake brick. */
export function fakeHidDevice(brick = new FakeEV3()) {
  const listeners: ReportListener[] = [];
  let plugged = true;
  const device: HidDeviceLike & { openError: Error | null } = {
    opened: false,
    vendorId: USB_VID,
    productId: USB_PID,
    productName: "EV3 fake",
    collections: [{ outputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 1024 }] }] }],
    openError: null,
    open: async () => {
      if (device.openError) throw device.openError;
      device.opened = true;
    },
    close: async () => {
      device.opened = false;
    },
    sendReport: async (_id, data) => {
      if (!plugged || !device.opened) throw new Error("The device was disconnected.");
      void brick.send(data).then(
        (reply) => {
          const report = new Uint8Array(1024);
          report.set(reply);
          for (const l of [...listeners]) l({ data: new DataView(report.buffer) });
        },
        () => {}, // a dropped reply: the link times out, as on a real cable
      );
    },
    addEventListener: (_type, l) => void listeners.push(l),
    removeEventListener: (_type, l) => void listeners.splice(listeners.indexOf(l), 1),
  };
  return {
    device,
    brick,
    unplug() {
      plugged = false;
    },
    plug() {
      plugged = true;
    },
  };
}

/** navigator.hid with a permission list, a chooser and plug events. */
export function fakeHid(o: { granted?: HidDeviceLike[]; chooser?: HidDeviceLike[] } = {}) {
  const granted = [...(o.granted ?? [])];
  const on = { connect: [] as PlugListener[], disconnect: [] as PlugListener[] };
  const hid: HidApi & { requests: number } = {
    requests: 0,
    getDevices: async () => [...granted],
    requestDevice: async () => {
      hid.requests++;
      const chosen = o.chooser ?? [];
      for (const d of chosen) if (!granted.includes(d)) granted.push(d);
      return [...chosen];
    },
    addEventListener: (type, l) => void on[type].push(l),
    removeEventListener: (type, l) => void on[type].splice(on[type].indexOf(l), 1),
  };
  return {
    hid,
    fire(type: "connect" | "disconnect", device: HidDeviceLike) {
      for (const l of [...on[type]]) l({ device });
    },
    listeners: on,
  };
}

/** A relay on 127.0.0.1: welcomes a hello (or refuses it), sends heartbeats, records every frame. */
export function fakeRelay(o: { refuse?: { code: number; reason: string } } = {}) {
  const received: RuntimeToRelay[] = [];
  const urls: string[] = [];
  let socket: { send(data: string): unknown; close(code?: number, reason?: string): unknown } | null = null;
  let seq = 0;
  let silent = false;
  const waiters: { match: (m: RuntimeToRelay) => boolean; resolve: (m: RuntimeToRelay) => void }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      urls.push(req.url);
      return srv.upgrade(req) ? undefined : new Response("websocket only", { status: 426 });
    },
    websocket: {
      open(ws) {
        socket = ws;
      },
      message(ws, raw) {
        const m = JSON.parse(String(raw)) as RuntimeToRelay;
        received.push(m);
        if (m.t === "hello") {
          if (o.refuse) ws.close(o.refuse.code, o.refuse.reason);
          else ws.send(JSON.stringify({ t: "welcome", session_id: "s1" } satisfies RelayToRuntime));
        }
        if (m.t === "hb" && !silent) ws.send(JSON.stringify({ t: "hb", ts: Date.now() } satisfies RelayToRuntime));
        for (const w of waiters.filter((w) => w.match(m))) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      },
      close(ws) {
        if (socket === ws) socket = null;
      },
    },
  });
  const send = (m: RelayToRuntime) => {
    if (!socket) throw new Error("fake relay: no runtime is connected");
    socket.send(JSON.stringify(m));
  };
  const next = <T extends RuntimeToRelay["t"]>(t: T, also: (m: Extract<RuntimeToRelay, { t: T }>) => boolean) =>
    new Promise<Extract<RuntimeToRelay, { t: T }>>((resolve) => {
      waiters.push({
        match: (m) => m.t === t && also(m as Extract<RuntimeToRelay, { t: T }>),
        resolve: (m) => resolve(m as Extract<RuntimeToRelay, { t: T }>),
      });
    });
  return {
    url: `ws://127.0.0.1:${server.port}/ws/robot`,
    received,
    urls,
    send,
    /** Dispatches a tool call as the relay does and resolves with the runtime's result frame. */
    call(tool: string, args: Record<string, unknown>) {
      const call_id = `c${++seq}`;
      const result = next("result", (m) => m.call_id === call_id);
      send({ t: "call", call_id, tool: tool as never, args, deadline_ms: 5000, activity: "idle" });
      return result;
    },
    stop() {
      const stop_id = `s${++seq}`;
      const stopped = next("stopped", (m) => m.stop_id === stop_id);
      send({ t: "stop", stop_id });
      return stopped;
    },
    /** The relay hangs: the socket stays open but nothing is answered any more. */
    goSilent() {
      silent = true;
    },
    /** The server disappears: sockets are cut and nothing listens any more. */
    async die() {
      // bun's stop(true) can stay pending after the server itself closed a socket with a code: do not wait on it
      await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 200))]);
    },
  };
}

export const ROBOT: RobotConfig = {
  profile: {
    id: "test-ev3",
    roles: { left_wheel: "ev3.B", right_wheel: "ev3.C" },
    drivetrain: {
      type: "differential",
      pair_device: "ev3.pair",
      wheel_diameter_cm: 5.6,
      axle_track_cm: 12,
      forward_sign: 1,
    },
    limits: {
      max_speed_pct: 60,
      max_command_ms: 15000,
      max_drive_cm: 100,
      max_turn_deg: 360,
      max_program_ms: 120000,
    },
    notes: [],
  },
  pair: { left: "B", right: "C" },
  hardware: { low_battery_v: 6.5, max_tone_ms: 5000, tone_volume_pct: 50 },
};
export const pageConfig = (serverUrl: string): PageConfig => ({
  serverUrl,
  robotId: "test-ev3",
  token: "secret-token",
  robot: ROBOT,
});

/** Polls until `check` passes; fails with `what` after `ms`. */
export async function until(what: string, check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
