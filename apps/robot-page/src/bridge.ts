// The local bridge page, without a DOM: it lends an EV3 to a spinecord process on this same computer (apps/local)
// by moving bytes and nothing else. WebHID output reports ⇄ one WebSocket on 127.0.0.1:
//   socket → page   binary: one framed direct command; the page pads it to the report size and sends it
//   page → socket   binary: one input report, cut to its length field
//   page → socket   text:   {"t":"device","report_bytes":n,"name":s} when an EV3 is open, {"t":"gone","why":s} when it is not
// No runtime, no polling and no timer on the path of a command: a browser slows the timers of a hidden or covered
// window down to one per second, but it delivers socket messages and HID reports at once. The runtime, with its
// 10 ms `until` watch, runs in the process at the other end of the socket.
// If the socket closes (the process ended or was killed) the page brakes every motor by itself.
import { ALL_OUTPUTS, USB_PID, USB_VID, frame, outputStop } from "../../../packages/driver-ev3/encode";
import { outputReportSize, type HidDeviceLike, type HidLike } from "../../../packages/driver-ev3/transport";

export interface BridgeHid extends HidLike {
  addEventListener?(type: "disconnect", listener: (ev: { device: HidDeviceLike }) => void): void;
}
export interface BridgeSocket {
  binaryType: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type DeviceState = "none" | "ready";
export type SocketState = "connecting" | "open" | "closed";
export const DEVICE_TRANSITIONS: Record<DeviceState, readonly DeviceState[]> = { none: ["ready"], ready: ["none"] };
export const SOCKET_TRANSITIONS: Record<SocketState, readonly SocketState[]> = {
  connecting: ["open", "closed"],
  open: ["closed"],
  closed: ["connecting"],
};
export interface BridgeStatus {
  device: DeviceState;
  deviceName: string | null;
  socket: SocketState;
  /** Why the last thing failed, for the person at the page; "" when nothing did. */
  detail: string;
  /** Commands forwarded to the brick since the page loaded. */
  packets: number;
}
export interface BridgeEnv {
  /** navigator.hid; absent when the browser has no WebHID. */
  hid?: BridgeHid;
  /** ws://127.0.0.1:<port>/hid of the process that served this page. */
  url: string;
  openSocket: (url: string) => BridgeSocket;
  onStatus: (s: BridgeStatus) => void;
  /** Pause before the socket is opened again after it closed, ms. Default 1000. */
  retryMs?: number;
}
export interface Bridge {
  /** Asks the person to pick an EV3 (needs a user gesture) and opens it. */
  choose(): Promise<void>;
  status(): BridgeStatus;
  dispose(): Promise<void>;
}

/** Sent without asking for a reply when the process goes away: brake every motor port. */
export const BRAKE_ALL = frame(outputStop(ALL_OUTPUTS, true), { counter: 0xffff, globals: 0, reply: false });

export function startBridge(env: BridgeEnv): Bridge {
  const retryMs = env.retryMs ?? 1000;
  let deviceState: DeviceState = "none";
  let socketState: SocketState = "closed";
  let device: HidDeviceLike | null = null;
  let reportBytes = 0;
  let socket: BridgeSocket | null = null;
  let detail = env.hid ? "" : "WebHID is not available: use Chrome or Edge on a desktop";
  let packets = 0;
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const status = (): BridgeStatus => ({
    device: deviceState,
    deviceName: device?.productName ?? null,
    socket: socketState,
    detail,
    packets,
  });
  const emit = () => {
    if (!disposed) env.onStatus(status());
  };
  const toDevice = (next: DeviceState) => {
    if (!DEVICE_TRANSITIONS[deviceState].includes(next))
      throw new Error(`bridge page: illegal device transition ${deviceState} → ${next}`);
    deviceState = next;
  };
  const toSocket = (next: SocketState) => {
    if (!SOCKET_TRANSITIONS[socketState].includes(next))
      throw new Error(`bridge page: illegal socket transition ${socketState} → ${next}`);
    socketState = next;
  };
  const tell = (msg: Record<string, unknown>) => {
    if (socket && socketState === "open") socket.send(JSON.stringify(msg));
  };
  const announce = () => {
    if (deviceState === "ready" && device)
      tell({ t: "device", report_bytes: reportBytes, name: device.productName ?? "" });
    else tell({ t: "gone", why: detail || "no EV3 is open in the page" });
  };

  const onReport = (ev: { data: DataView }) => {
    const raw = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
    if (raw.length < 5 || !socket || socketState !== "open") return;
    const len = raw[0]! | (raw[1]! << 8);
    // a length field past the report is forwarded whole: the other end reports it as a bad reply
    socket.send(raw.slice(0, Math.min(len + 2, raw.length)));
  };

  async function forward(bytes: Uint8Array): Promise<void> {
    const d = device;
    if (deviceState !== "ready" || !d) return tell({ t: "gone", why: "no EV3 is open in the page" });
    if (bytes.length > reportBytes)
      return tell({
        t: "error",
        message: `packet of ${bytes.length} bytes does not fit the ${reportBytes}-byte report`,
      });
    const report = new Uint8Array(reportBytes);
    report.set(bytes);
    try {
      await d.sendReport(0, report);
      packets++;
    } catch (e) {
      // the cable or the brick went away: the device is gone until the person plugs it in again
      await lose(`the EV3 does not take reports: ${(e as Error).message}`);
    }
  }

  async function lose(why: string): Promise<void> {
    if (deviceState !== "ready") return;
    const d = device;
    toDevice("none");
    device = null;
    detail = why;
    d?.removeEventListener("inputreport", onReport);
    await d?.close().catch(() => {});
    announce();
    emit();
  }

  // one open at a time: the automatic one at load and the button's may come together
  let opening: Promise<void> | null = null;
  function open(d: HidDeviceLike): Promise<void> {
    opening ??= openOnce(d).finally(() => {
      opening = null;
    });
    return opening;
  }
  async function openOnce(d: HidDeviceLike): Promise<void> {
    if (deviceState === "ready") return;
    if (d.vendorId !== USB_VID || d.productId !== USB_PID) throw new Error("that device is not an EV3");
    if (!d.opened) await d.open();
    reportBytes = outputReportSize(d);
    d.addEventListener("inputreport", onReport);
    device = d;
    detail = "";
    toDevice("ready");
    announce();
    emit();
  }

  function connectSocket(): void {
    if (disposed || socketState !== "closed") return;
    toSocket("connecting");
    const s = env.openSocket(env.url);
    s.binaryType = "arraybuffer";
    socket = s;
    s.onopen = () => {
      if (socket !== s) return;
      toSocket("open");
      announce();
      emit();
    };
    s.onmessage = (ev) => {
      if (socket !== s) return;
      if (ev.data instanceof ArrayBuffer) void forward(new Uint8Array(ev.data));
      else if (ev.data instanceof Uint8Array) void forward(ev.data);
    };
    s.onclose = (ev) => {
      if (socket !== s) return;
      socket = null;
      const wasOpen = socketState === "open";
      toSocket("closed");
      if (ev.reason) detail = ev.reason;
      // nobody is at the other end any more: whatever was moving stops here
      if (wasOpen && deviceState === "ready" && device) {
        const report = new Uint8Array(reportBytes);
        report.set(BRAKE_ALL);
        void device.sendReport(0, report).catch(() => {});
      }
      emit();
      if (!disposed) retry = setTimeout(connectSocket, retryMs);
    };
    emit();
  }

  env.hid?.addEventListener?.("disconnect", (ev) => {
    if (ev.device === device) void lose("the EV3 was unplugged or switched off");
  });
  // an EV3 this browser already has permission for is opened without a click
  void env.hid
    ?.getDevices()
    .then((granted) => {
      const d = granted.find((g) => g.vendorId === USB_VID && g.productId === USB_PID);
      if (d && !disposed) return open(d);
    })
    .catch((e) => {
      detail = `could not open the EV3: ${(e as Error).message}`;
      emit();
    });
  connectSocket();

  return {
    async choose() {
      if (!env.hid) throw new Error("WebHID is not available: use Chrome or Edge on a desktop");
      const picked = await env.hid.requestDevice({ filters: [{ vendorId: USB_VID, productId: USB_PID }] });
      if (!picked.length) {
        detail = "no EV3 was chosen";
        return emit();
      }
      try {
        await open(picked[0]!);
      } catch (e) {
        detail = `could not open the EV3: ${(e as Error).message}`;
        emit();
      }
    },
    status,
    async dispose() {
      disposed = true;
      if (retry) clearTimeout(retry);
      const s = socket;
      socket = null;
      s?.close();
      const d = device;
      device = null;
      d?.removeEventListener("inputreport", onReport);
      await d?.close().catch(() => {});
    },
  };
}
