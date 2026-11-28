import { expect, test } from "bun:test";
import { statusChips } from "./status";

test("all well: connected, robot online and at rest or moving, the top bar shows no chip", () => {
  const none = { ws: null, link: null, activity: null };
  expect(statusChips(true, { link: "online", activity: "idle" })).toEqual(none);
  expect(statusChips(true, { link: "online", activity: "acting" })).toEqual(none);
  expect(statusChips(true, { link: "online", activity: "stopping" })).toEqual(none);
  expect(statusChips(true, null)).toEqual(none);
});

test("a problem shows, alone: no connection, the robot offline or faulted, a program moving it", () => {
  expect(statusChips(false, null)).toEqual({ ws: ["Sin conexión · reintentando", "bad"], link: null, activity: null });
  // the robot's last state is not shown while the page is cut off
  expect(statusChips(false, { link: "online", activity: "idle" }).link).toBeNull();
  expect(statusChips(true, { link: "offline", activity: "idle" })).toEqual({
    ws: null,
    link: ["desconectado", "bad"],
    activity: null,
  });
  expect(statusChips(true, { link: "handshaking", activity: "idle" }).link).toEqual(["conectando", "warn"]);
  expect(statusChips(true, { link: "online", activity: "fault" }).activity).toEqual(["en falla", "bad"]);
  expect(statusChips(true, { link: "online", activity: "running_program" }).activity).toEqual([
    "corriendo un programa",
    "busy",
  ]);
  // a state the page does not know yet is shown, not hidden
  expect(statusChips(true, { link: "online", activity: "dancing" }).activity).toEqual(["dancing", "warn"]);
});
