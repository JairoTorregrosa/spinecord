// Transports: one packet out, its reply back. Serialisation, timeouts and counter
// checks live in link.ts; a transport only moves bytes.
import { USB_PID, USB_VID } from "./encode";

export interface Transport {
  /** Send one framed command (unpadded) and resolve with its reply, cut to 2+len bytes. */
  send(bytes: Uint8Array): Promise<Uint8Array>;
  close?(): Promise<void>;
}

// Minimal WebHID shapes, so this file needs no DOM typings package.
export interface HidReportItemLike {
  reportSize?: number;
  reportCount?: number;
}
export interface HidReportInfoLike {
  reportId?: number;
  items?: HidReportItemLike[];
}
export interface HidCollectionLike {
  outputReports?: HidReportInfoLike[];
}
export interface HidDeviceLike {
  opened: boolean;
  vendorId: number;
  productId: number;
  productName?: string;
  collections: HidCollectionLike[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
  addEventListener(type: "inputreport", listener: (ev: { data: DataView }) => void): void;
  removeEventListener(type: "inputreport", listener: (ev: { data: DataView }) => void): void;
}
export interface HidLike {
  requestDevice(options: { filters: { vendorId: number; productId: number }[] }): Promise<HidDeviceLike[]>;
  getDevices(): Promise<HidDeviceLike[]>;
}

export class TransportError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

/** Output report size in bytes from the HID descriptor: 1024 on high-speed USB, 64 on full-speed. */
export function outputReportSize(device: HidDeviceLike): number {
  const report = device.collections?.[0]?.outputReports?.[0];
  let bits = 0;
  for (const item of report?.items ?? []) bits += (item.reportSize ?? 0) * (item.reportCount ?? 0);
  const bytes = bits / 8;
  if (!Number.isInteger(bytes) || bytes < 16) {
    throw new TransportError(
      "bad_descriptor",
      `cannot read the EV3 output report size from the HID descriptor (got ${bits} bits)`,
    );
  }
  return bytes;
}

interface Waiter {
  counter: number;
  resolve: (d: Uint8Array) => void;
  reject: (e: Error) => void;
}

/** EV3 over WebHID (Chrome). The device must already be granted; see `WebHIDTransport.request`. */
export class WebHIDTransport implements Transport {
  readonly reportSize: number;
  private waiter: Waiter | null = null;
  private readonly onReport = (ev: { data: DataView }) => this.handleReport(ev.data);

  private constructor(private readonly device: HidDeviceLike) {
    this.reportSize = outputReportSize(device);
    device.addEventListener("inputreport", this.onReport);
  }

  static supported(): boolean {
    return typeof navigator !== "undefined" && !!(navigator as unknown as { hid?: HidLike }).hid;
  }

  /** Ask the user to pick an EV3 (needs a user gesture) and open it. */
  static async request(hid?: HidLike): Promise<WebHIDTransport> {
    const api = hid ?? (globalThis as unknown as { navigator?: { hid?: HidLike } }).navigator?.hid;
    if (!api)
      throw new TransportError(
        "webhid_unsupported",
        "WebHID is not available: use Chrome or Edge on a desktop, over https or localhost",
      );
    const devices = await api.requestDevice({ filters: [{ vendorId: USB_VID, productId: USB_PID }] });
    if (!devices.length) throw new TransportError("no_device", "no EV3 was chosen");
    return WebHIDTransport.open(devices[0]);
  }

  /** Open a device object obtained from requestDevice() or getDevices(). */
  static async open(device: HidDeviceLike): Promise<WebHIDTransport> {
    if (device.vendorId !== USB_VID || device.productId !== USB_PID) {
      throw new TransportError(
        "not_ev3",
        `device ${device.vendorId.toString(16)}:${device.productId.toString(16)} is not an EV3 (0694:0005)`,
      );
    }
    if (!device.opened) await device.open();
    return new WebHIDTransport(device);
  }

  async send(bytes: Uint8Array): Promise<Uint8Array> {
    if (bytes.length < 4) throw new TransportError("bad_packet", "packet too short");
    if (bytes.length > this.reportSize) {
      throw new TransportError(
        "too_long",
        `packet of ${bytes.length} bytes does not fit the ${this.reportSize}-byte report`,
      );
    }
    const counter = bytes[2] | (bytes[3] << 8);
    // One exchange at a time. A new send supersedes a reply nobody collected (its caller timed out).
    this.waiter?.reject(new TransportError("superseded", "a newer command was sent before this reply arrived"));
    const reply = new Promise<Uint8Array>((resolve, reject) => {
      this.waiter = { counter, resolve, reject };
    });
    reply.catch(() => {});
    const report = new Uint8Array(this.reportSize);
    report.set(bytes);
    try {
      await this.device.sendReport(0, report);
    } catch (e) {
      if (this.waiter?.counter === counter) this.waiter = null;
      throw new TransportError("send_failed", `sendReport failed: ${(e as Error).message}`);
    }
    return reply;
  }

  private handleReport(data: DataView): void {
    const raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (raw.length < 5) return;
    const len = raw[0] | (raw[1] << 8);
    const counter = raw[2] | (raw[3] << 8);
    const w = this.waiter;
    // Late replies to commands that already timed out carry another counter: drop them.
    if (!w || w.counter !== counter) return;
    this.waiter = null;
    if (len + 2 > raw.length) {
      w.reject(new TransportError("bad_reply", `reply length field ${len} exceeds the ${raw.length}-byte report`));
      return;
    }
    w.resolve(raw.slice(0, len + 2));
  }

  async close(): Promise<void> {
    this.device.removeEventListener("inputreport", this.onReport);
    this.waiter?.reject(new TransportError("closed", "transport closed"));
    this.waiter = null;
    await this.device.close();
  }
}
