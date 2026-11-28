import { expect, test } from "bun:test";
import { Follow, RESUME_MS, isClaudeCall } from "./activity";
import type { ServerMessage } from "./messages";

test("the panel lists Claude's tool calls only: not the hand, not the world's events", () => {
  const start: ServerMessage = { t: "call_start", n: 1, at: 0, tool: "drive", robot_id: "r", args: "{}" };
  const end: ServerMessage = {
    t: "call_end",
    n: 1,
    at: 1,
    tool: "drive",
    robot_id: "r",
    ok: true,
    code: null,
    summary: "drive ok",
    ms: 1,
  };
  const hand: ServerMessage[] = [
    { t: "events", id: "r", events: [{ n: 1, t_ms: 0, kind: "placed", how: "carried" }] },
    { t: "events", id: "r", events: [{ n: 2, t_ms: 0, kind: "obstacle_changed", box: "box1", change: "added" }] },
    { t: "boxes", id: "r", rev: 2, boxes: [] },
    { t: "reply", req: 1, ok: true },
    { t: "tone", id: "r", hz: 440, ms: 100, volume: 50 },
  ];
  expect(isClaudeCall(start)).toBe(true);
  expect(isClaudeCall(end)).toBe(true);
  for (const m of hand) expect(isClaudeCall(m)).toBe(false);
});

test("from the first call on, every new call is shown: the list follows", () => {
  const f = new Follow();
  for (let i = 0; i < 200; i++) expect(f.added()).toBe(true);
  expect(f.unseen).toBe(0);
});

test("reading older calls keeps the place and counts what came; back at the top it follows again", () => {
  const f = new Follow();
  f.touched(false, 0);
  for (let i = 0; i < 5; i++) expect(f.added()).toBe(false);
  expect(f.unseen).toBe(5);
  // a scroll the page makes to keep the place changes nothing
  f.scrolled(false);
  expect(f.following).toBe(false);
  f.scrolled(true);
  expect(f.following).toBe(true);
  expect(f.unseen).toBe(0);
  expect(f.added()).toBe(true);
});

test("left alone, the list returns to the newest call after RESUME_MS, even while calls keep coming", () => {
  const f = new Follow();
  f.touched(false, 1000);
  for (let t = 1000; t < 1000 + RESUME_MS; t += 500) {
    f.added();
    f.scrolled(false); // the page keeping the place: not the person, so the wait goes on
    expect(f.tick(t)).toBe(false);
  }
  expect(f.tick(1000 + RESUME_MS)).toBe(true);
  expect(f.following).toBe(true);
  expect(f.unseen).toBe(0);
  expect(f.tick(1000 + 2 * RESUME_MS)).toBe(false);
});

test("the person touching the list again restarts the wait", () => {
  const f = new Follow();
  f.touched(false, 0);
  f.touched(false, RESUME_MS - 1);
  expect(f.tick(RESUME_MS)).toBe(false);
  expect(f.tick(2 * RESUME_MS - 1)).toBe(true);
});
