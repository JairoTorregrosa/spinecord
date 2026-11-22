// The DOM around src/bridge.ts: one button and a status line. The socket is on the origin that served the page.
import { startBridge, type BridgeHid, type BridgeSocket, type BridgeStatus } from "./bridge";

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`bridge page: element #${id} is missing`);
  return node as T;
};
const button = el<HTMLButtonElement>("choose");

function draw(s: BridgeStatus): void {
  el("s-device").textContent = s.device === "ready" ? `connected (${s.deviceName || "EV3"})` : "not connected";
  el("s-socket").textContent =
    s.socket === "open"
      ? "connected"
      : s.taken
        ? "another tab already holds the robot"
        : s.socket === "connecting"
          ? "connecting…"
          : "not running (retrying)";
  el("s-packets").textContent = String(s.packets);
  el("s-detail").textContent = s.detail;
  button.hidden = s.device === "ready";
  document.title = s.device === "ready" && s.socket === "open" ? "EV3 lent · spinecord" : "Lend an EV3 · spinecord";
}

const bridge = startBridge({
  hid: (navigator as unknown as { hid?: BridgeHid }).hid,
  url: `ws://${location.host}/hid`,
  openSocket: (url) => new WebSocket(url) as unknown as BridgeSocket,
  onStatus: draw,
});
draw(bridge.status());
button.addEventListener("click", () => void bridge.choose());
// packets counter without a status event per packet
setInterval(() => draw(bridge.status()), 1000);
