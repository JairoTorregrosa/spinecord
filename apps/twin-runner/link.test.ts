import { describe, expect, test } from "bun:test";
import { backoffMs, judgeClose, upgradeUrl } from "./link";

const SERVER = "ws://relay.test/ws/robot";
const answers = (status: number, body = "") => {
  const seen: { url: string; upgrade: string | null }[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    seen.push({ url, upgrade: new Headers(init.headers).get("upgrade") });
    return new Response(body, { status });
  };
  return { seen, fetchFn };
};

describe("judgeClose", () => {
  test.each([401, 403, 404])("HTTP %d on the upgrade is permanent", async (status) => {
    const { seen, fetchFn } = answers(status, '{"error":"unknown_robot"}');
    const v = await judgeClose("code 1002 Expected 101 status code", SERVER, "x-sim", fetchFn);
    expect(v.retry).toBe(false);
    expect(v.why).toContain(`HTTP ${status}`);
    expect(v.why).toContain("unknown_robot");
    expect(seen).toEqual([{ url: "http://relay.test/ws/robot?robot_id=x-sim", upgrade: "websocket" }]);
  });

  test.each([500, 502, 503, 429, 408, 101, 200])("HTTP %d is retried", async (status) => {
    const { fetchFn } = answers(status === 101 ? 200 : status);
    expect((await judgeClose("code 1006", SERVER, "x-sim", fetchFn)).retry).toBe(true);
  });

  test("a relay that cannot be reached is retried", async () => {
    const v = await judgeClose("code 1006 Failed to connect", SERVER, "x-sim", async () => {
      throw new Error("connection refused");
    });
    expect(v).toEqual({ retry: true, why: expect.stringContaining("connection refused") });
  });

  test("the relay's refusal close codes are permanent without asking", async () => {
    for (const code of [4001, 4002]) {
      const { seen, fetchFn } = answers(200);
      const v = await judgeClose(`code ${code} unauthorized`, SERVER, "x-sim", fetchFn);
      expect(v.retry).toBe(false);
      expect(seen).toEqual([]);
    }
  });
});

test("upgradeUrl appends the robot id only when the URL has none; wss becomes https for the probe", async () => {
  expect(upgradeUrl(SERVER, "a-sim")).toBe("ws://relay.test/ws/robot?robot_id=a-sim");
  expect(upgradeUrl(`${SERVER}?x=1`, "a-sim")).toBe("ws://relay.test/ws/robot?x=1&robot_id=a-sim");
  expect(upgradeUrl(`${SERVER}?robot_id=b-sim`, "a-sim")).toBe("ws://relay.test/ws/robot?robot_id=b-sim");
  const { seen, fetchFn } = answers(404);
  await judgeClose("code 1002", "wss://relay.test/ws/robot", "a-sim", fetchFn);
  expect(seen[0]!.url).toBe("https://relay.test/ws/robot?robot_id=a-sim");
});

test("backoff doubles from 1 s and stops at 15 s", () => {
  expect([0, 1, 2, 3, 4, 5, 50].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
});
