// Page script of the hidden-window measurement (bench/hidden-page.ts): the real bridge (apps/robot-page/src/bridge.ts)
// with a simulated EV3 behind a fake WebHID, so the whole link runs in a real browser without a brick.
// Next to it, a 10 ms timer reports how often the browser really fires it: that is the cadence a runtime
// inside the page would have for its `until` watch.
import robotFile from "../../../deployments/example/robots/r1.json";
import { parseRobotFile } from "../../../packages/driver-ev3/robot-file";
import type { FakeEV3 } from "../../../packages/driver-ev3/fake";
import { SimBrick, drivetrainFromProfile } from "../../../packages/sim-ev3/brick";
import { NO_NOISE, World, parseWorld } from "../../../packages/sim-world/world";
import { startBridge, type BridgeSocket } from "../../robot-page/src/bridge";
import { fakeHid, fakeHidDevice } from "../../robot-page/test/fakes";
import room from "../examples/room.json";

const robot = parseRobotFile(robotFile, "r1.json");
const brick = new SimBrick({
  world: new World({ ...parseWorld(room), noise: NO_NOISE }, 1),
  drivetrain: drivetrainFromProfile(robot.profile, robot.pair),
});
const usb = fakeHidDevice(brick as unknown as FakeEV3);
let socket: WebSocket | null = null;
startBridge({
  hid: fakeHid({ granted: [usb.device] }).hid,
  url: `ws://${location.host}/hid`,
  openSocket: (url) => {
    socket = new WebSocket(url);
    return socket as unknown as BridgeSocket;
  },
  onStatus: (s) => {
    document.title = `${s.device} / ${s.socket}`;
  },
});

let last = performance.now();
let gaps: number[] = [];
setInterval(() => {
  const now = performance.now();
  gaps.push(now - last);
  last = now;
}, 10);
function report(): void {
  if (socket?.readyState === WebSocket.OPEN && gaps.length) {
    const sorted = [...gaps].sort((a, b) => a - b);
    socket.send(
      JSON.stringify({
        t: "timers",
        visibility: document.visibilityState,
        fired: gaps.length,
        gap_ms_p50: sorted[Math.floor(sorted.length / 2)],
        gap_ms_max: sorted[sorted.length - 1],
      }),
    );
  }
  gaps = [];
}
setInterval(report, 1000);
