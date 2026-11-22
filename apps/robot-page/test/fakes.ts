// Test doubles for the browser end of the bridge page: a WebHID device backed by the driver's FakeEV3 (so the
// real bytes of the EV3 protocol run) and navigator.hid around it.
import { USB_PID, USB_VID } from "../../../packages/driver-ev3/encode";
import { FakeEV3 } from "../../../packages/driver-ev3/fake";
import type { HidDeviceLike, HidLike } from "../../../packages/driver-ev3/transport";

/** navigator.hid as a page sees it: the chooser, the permission list and plug events. */
export interface HidApi extends HidLike {
  addEventListener(type: "connect" | "disconnect", listener: (ev: { device: HidDeviceLike }) => void): void;
  removeEventListener(type: "connect" | "disconnect", listener: (ev: { device: HidDeviceLike }) => void): void;
}

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
