// The page joins again by itself after its socket closed (CONTRACT §2.4, Sleep): a new socket after the backoff,
// the same name and token, what is down and the person's pause said again after the welcome, the media and the
// wake lock taken back before the hello of a page that is visible again, and the closes after which it stops.
import { describe, expect, test } from "bun:test";
import type { PageDevice } from "../../../packages/protocol/types";
import { createPage } from "../src/page";
import { fakeBrowser, fakeSocket, tick, type FakeBrowserOptions } from "./fakes";

const PHONE: FakeBrowserOptions = { motion: "events", vibrate: true, pointer: "coarse", torch: true };

function rig(
  o: FakeBrowserOptions = {},
  rejoin: { delays_ms: number[]; window_ms: number; prepare_ms?: number } = {
    delays_ms: [20, 40, 80, 100],
    window_ms: 1500,
  },
) {
  const browser = fakeBrowser(o);
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const openedAt: number[] = [];
  /** What happened, in order: a getUserMedia call or a socket opened. */
  const order: string[] = [];
  let visible = true;
  const asked = browser.asked;
  const page = createPage({
    win: browser.win,
    url: "ws://127.0.0.1:1/page",
    token: "tok",
    openSocket: () => {
      const s = fakeSocket();
      sockets.push(s);
      openedAt.push(Date.now());
      order.push(`socket after ${asked.length} media asks`);
      return s.socket;
    },
    visible: () => visible,
    lang: "es-ES",
    workletUrl: "level.js",
    render: () => {},
    onLabels: () => {},
    rejoin,
  });
  const sock = () => sockets.at(-1)!;
  const hello = (s = sock()) =>
    s.json().find((m) => m.t === "hello") as { name: string; token: string; devices: PageDevice[] };
  /** The latest socket opens and the process welcomes the page. */
  const welcome = (name = "desk") => {
    sock().open();
    sock().receive({ t: "welcome", name, robot: "r1" });
  };
  const join = async (name = "desk") => {
    await page.lend({ name });
    welcome(name);
  };
  /** Waits until the page opened `n` sockets in all. */
  const opened = async (n: number, ms = 2000) => {
    for (let t = 0; sockets.length < n && t < ms; t += 5) await tick(5);
    expect(sockets.length).toBe(n);
  };
  const setVisible = (v: boolean) => {
    visible = v;
    page.visibilityChanged();
  };
  return { browser, page, sockets, sock, hello, welcome, join, opened, openedAt, order, setVisible };
}

describe("joining again after the socket closed", () => {
  test("a closed socket leads to a new one, with the same name and token, and the pushed values again", async () => {
    const r = rig();
    await r.join("phone");
    r.page.touch.press(0);
    r.sock().closeFromServer(1006, "");
    expect(r.page.kit.status()).toMatchObject({
      state: "reconnecting",
      rejoin: { attempt: 0, code: 1006 },
      devices: expect.arrayContaining(["camera", "touch"]),
    });
    await r.opened(2);
    expect(r.page.kit.status().state).toBe("joining");
    r.sock().open();
    const again = r.hello();
    const first = r.hello(r.sockets[0]);
    expect(again).toMatchObject({ t: "hello", name: "phone", token: "tok" });
    expect(again.devices.map((d) => d.id)).toEqual(first.devices.map((d) => d.id));
    r.sock().receive({ t: "welcome", name: "phone", robot: "r1" });
    expect(r.page.kit.status()).toMatchObject({ state: "lending", rejoin: null, name: "phone" });
    // the process starts afresh: every pushed value is sent again, the button still held among them
    const touch = r
      .sock()
      .json()
      .find((m) => m.t === "state" && m.device === "touch");
    expect(touch?.values).toMatchObject({ b1: true, b1_presses: 1 });
  });

  test("the tries wait 0.5, 1, 2 and then 5 s (here shortened), and the count starts again after a welcome", async () => {
    const r = rig();
    await r.join();
    r.sock().closeFromServer(1006, "");
    for (let n = 2; n <= 6; n++) {
      await r.opened(n);
      r.sock().closeFromServer(1006, ""); // the process cannot be reached
    }
    const gaps = r.openedAt.slice(1).map((t, i) => t - r.openedAt[i]!);
    // the first gap counts from the welcome's socket; then 40, 80, 100, 100
    for (const [i, want] of [40, 80, 100, 100].entries()) expect(gaps[i + 1]!).toBeGreaterThanOrEqual(want - 5);
    expect(r.page.kit.status().rejoin?.attempt).toBe(5);
    await r.opened(7);
    r.welcome();
    expect(r.page.kit.status().rejoin).toBeNull();
    r.sock().closeFromServer(1006, "");
    expect(r.page.kit.status().rejoin?.attempt).toBe(0);
    await r.opened(8);
  });

  test("a refused token stops it at once, with the process's reason: no loop", async () => {
    const r = rig();
    await r.join();
    r.sock().closeFromServer(1006, "");
    await r.opened(2);
    r.sock().open();
    r.sock().closeFromServer(4001, "bad or missing token: open the page this server serves");
    expect(r.page.kit.status()).toMatchObject({
      state: "closed",
      closed: { code: 4001, reason: "bad or missing token: open the page this server serves" },
      rejoin: null,
    });
    await tick(300);
    expect(r.sockets.length).toBe(2);
  });

  test("an unknown robot, a refused manifest, too many pages and the process ending stop it too", async () => {
    for (const code of [4000, 4004, 4010, 4029, 1001]) {
      const r = rig();
      await r.join();
      r.sock().closeFromServer(code, "refused");
      expect(r.page.kit.status().state).toBe("closed");
      await tick(60);
      expect(r.sockets.length).toBe(1);
    }
  });

  test("a name still held by the dead socket is tried again: the process lets it go when it sees the close", async () => {
    const r = rig();
    await r.join();
    r.sock().closeFromServer(1006, "");
    await r.opened(2);
    r.sock().open();
    r.sock().closeFromServer(4009, "the name desk is taken");
    expect(r.page.kit.status().state).toBe("reconnecting");
    await r.opened(3);
    r.welcome();
    expect(r.page.kit.status().state).toBe("lending");
  });

  test("away longer than the process keeps its place, it stops and says why", async () => {
    const r = rig({}, { delays_ms: [20], window_ms: 1000 });
    await r.join();
    r.sock().closeFromServer(1006, "");
    for (let i = 0; i < 300 && r.page.kit.status().state !== "closed"; i++) {
      await tick(10);
      if (r.page.kit.status().state === "joining") r.sock().closeFromServer(1006, "");
    }
    const s = r.page.kit.status();
    expect(s.state).toBe("closed");
    expect(s.closed!.reason).toStartWith("The page could not join again within 1 s, so the robot let its place go");
    const n = r.sockets.length;
    await tick(100);
    expect(r.sockets.length).toBe(n);
  });

  test("a first join that fails is closed: there is no place to take back", async () => {
    const r = rig();
    await r.page.lend({ name: "desk" });
    r.sock().closeFromServer(1006, "");
    expect(r.page.kit.status().state).toBe("closed");
    await tick(60);
    expect(r.sockets.length).toBe(1);
  });

  test("the person closing the page while it waits ends the waiting", async () => {
    const r = rig({}, { delays_ms: [50], window_ms: 1500 });
    await r.join();
    r.sock().closeFromServer(1006, "");
    r.page.kit.close();
    expect(r.page.kit.status()).toMatchObject({ state: "closed", closed: { code: 1000 } });
    await tick(100);
    expect(r.sockets.length).toBe(1);
  });

  test("a pause outlives the close: after the welcome the page says paused again", async () => {
    const r = rig();
    await r.join();
    r.page.kit.pause("the person pressed pause");
    r.sock().closeFromServer(1006, "");
    expect(r.page.kit.status()).toMatchObject({ state: "reconnecting", held: true });
    await r.opened(2);
    r.welcome();
    expect(r.page.kit.status()).toMatchObject({ state: "paused", held: true });
    expect(r.sock().json().at(-1)).toEqual({ t: "paused", why: "the person pressed pause" });
    r.page.kit.resume();
    expect(r.sock().json().at(-1)).toEqual({ t: "resumed" });
    expect(r.page.kit.status()).toMatchObject({ state: "lending", held: false });
  });

  test("a device that is down is said down again after the welcome", async () => {
    const r = rig(PHONE);
    await r.join("phone");
    r.setVisible(false); // the imu is down while hidden
    r.sock().closeFromServer(1006, "");
    await r.opened(2);
    r.welcome("phone");
    expect(r.sock().json()).toContainEqual({
      t: "down",
      device: "imu",
      why: "the page is hidden: the browser sends it no motion events",
    });
  });

  test("visible again: it tries at once, after taking back the camera and the wake lock, so the hello lends the camera", async () => {
    const r = rig(PHONE, { delays_ms: [10_000], window_ms: 30_000 });
    await r.join("phone");
    await tick(1);
    // locked: the browser hides the page, drops the wake lock, ends the camera and closes the socket
    r.setVisible(false);
    r.browser.wake.sentinels.at(-1)!.fireRelease();
    const ended = r.browser.video;
    ended.end();
    r.sock().closeFromServer(1006, "");
    const asks = r.browser.asked.length;
    const locks = r.browser.wake.requests;
    expect(r.page.kit.status().state).toBe("reconnecting");
    r.setVisible(true);
    await r.opened(2, 200);
    expect(r.browser.wake.requests).toBeGreaterThan(locks);
    expect(r.browser.asked.slice(asks)).toContain("camera");
    expect(r.order.at(-1)).toBe(`socket after ${r.browser.asked.length} media asks`);
    expect(r.browser.video).not.toBe(ended);
    r.sock().open();
    expect(r.hello().devices.map((d) => d.id)).toContain("camera");
    r.welcome("phone");
    expect(r.page.kit.status().state).toBe("lending");
    expect(r.page.wake()).toEqual({ t: "held" });
  });

  test("a camera that never comes back does not hold the try: after prepare_ms the hello lends what there is", async () => {
    const r = rig(PHONE, { delays_ms: [10_000], window_ms: 30_000, prepare_ms: 50 });
    await r.join("phone");
    r.setVisible(false);
    r.browser.video.end();
    r.sock().closeFromServer(1006, "");
    r.browser.holdMedia();
    r.setVisible(true);
    await r.opened(2, 500);
    r.sock().open();
    expect(r.hello().name).toBe("phone");
    r.welcome("phone");
    expect(r.page.kit.status().state).toBe("lending");
    // the camera's track is still ended: it is said down after the welcome
    expect(r.sock().json()).toContainEqual({
      t: "down",
      device: "camera",
      why: "the camera was turned off or unplugged",
    });
  });

  test("a try that hangs before its welcome still ends with the window, and says why", async () => {
    const r = rig({}, { delays_ms: [20], window_ms: 300 });
    await r.join();
    r.sock().closeFromServer(1006, "");
    await r.opened(2);
    // the new socket never opens: no close, no welcome
    for (let i = 0; i < 100 && r.page.kit.status().state !== "closed"; i++) await tick(10);
    expect(r.page.kit.status().state).toBe("closed");
    expect(r.page.kit.status().closed!.reason).toContain("could not join again");
    await tick(60);
    expect(r.sockets.length).toBe(2);
  });

  test("visible again while a try waits for its welcome: the imu is up and the camera taken back", async () => {
    const r = rig(PHONE, { delays_ms: [20], window_ms: 30_000 });
    await r.join("phone");
    r.setVisible(false);
    const ended = r.browser.video;
    ended.end();
    r.sock().closeFromServer(1006, "");
    await r.opened(2); // the timer's try, while hidden
    r.setVisible(true);
    await tick(5);
    expect(r.browser.video).not.toBe(ended);
    r.welcome("phone");
    const after = r.sock().json();
    expect(after.some((m) => m.t === "down" && m.device === "imu")).toBe(false);
    expect(after.some((m) => m.t === "down" && m.device === "camera")).toBe(false);
  });

  test("the wake lock is kept while the page waits to join again", async () => {
    const r = rig();
    await r.join();
    await tick(1);
    r.sock().closeFromServer(1006, "");
    expect(r.browser.wake.sentinels[0]!.released).toBe(false);
    r.page.kit.close();
    expect(r.browser.wake.sentinels[0]!.released).toBe(true);
  });
});
