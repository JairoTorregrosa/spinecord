import { expect, test } from "bun:test";
import { Follow, RESUME_MS, ScrollOwner, isClaudeCall, keptScrollTop } from "./activity";
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

/** What hud.ts does with each scroll of the list: the page's own changes nothing, any other is the person's. */
function scroll(f: Follow, o: ScrollOwner, top: number, now: number): void {
  if (o.byPage(top)) f.scrolled(top <= 4);
  else f.touched(top <= 4, now);
}

test("a finger held still on the list before it drags: the drag is the person's, and the next call keeps the place", () => {
  const f = new Follow(),
    o = new ScrollOwner();
  o.set(0); // the page showed the top: no scroll, the list was already there
  o.personActs(); // pointerdown at the top: nothing to read yet
  scroll(f, o, 300, 700); // 700 ms later the finger drags
  expect(f.following).toBe(false);
  expect(f.added()).toBe(false);
  o.set(330); // the page keeps the place under the new row
  scroll(f, o, 330, 800);
  expect(f.following).toBe(false);
  expect(f.unseen).toBe(1);
});

test("a long drag keeps reading however long it lasts, with calls coming; the wait starts when it ends", () => {
  const f = new Follow(),
    o = new ScrollOwner();
  let top = 100;
  for (let t = 0; t <= 15_000; t += 500) {
    scroll(f, o, (top += 10), t); // the person's drag
    expect(f.tick(t)).toBe(false);
    f.added();
    o.set((top += 30)); // the page holds their row still under the new call
    scroll(f, o, top, t + 1);
    expect(f.following).toBe(false);
  }
  expect(f.tick(15_000 + RESUME_MS - 1)).toBe(false);
  expect(f.tick(15_000 + RESUME_MS)).toBe(true);
});

test("a smooth return to the top the page starts is the page's, until the person takes over", () => {
  const f = new Follow(),
    o = new ScrollOwner();
  scroll(f, o, 500, 0);
  f.reset();
  o.glide(0);
  scroll(f, o, 300, 10);
  expect(f.following).toBe(true);
  o.personActs();
  scroll(f, o, 400, 20);
  expect(f.following).toBe(false);
});

test("folding the panel ends reading: it opens on the newest call", () => {
  const f = new Follow();
  f.touched(false, 0);
  f.added();
  expect(f.folded()).toBe(true);
  expect(f.following).toBe(true);
  expect(f.unseen).toBe(0);
  expect(f.folded()).toBe(false);
});

test("at the cap of rows, a new call on top and the oldest trimmed: the row the person reads stays put", () => {
  // a list of 80 rows of mixed heights; the person reads at scrollTop 600
  const CAP = 80;
  let rows = Array.from({ length: CAP }, (_, i) => ({ id: i, h: 30 + (i % 3) * 12 }));
  const top = (id: number) => {
    let y = 0;
    for (const r of rows) {
      if (r.id === id) return y;
      y += r.h;
    }
    throw new Error("gone");
  };
  let scrollTop = 600;
  for (let n = CAP; n < CAP + 50; n++) {
    // the anchor: the first row whose bottom is below the top edge
    const a = rows.find((r) => top(r.id) + r.h > scrollTop)!;
    const before = top(a.id) - scrollTop;
    const onScreen = before;
    rows = [{ id: n, h: 30 + (n % 3) * 12 }, ...rows].slice(0, CAP);
    scrollTop = keptScrollTop(scrollTop, before, top(a.id) - scrollTop);
    expect(top(a.id) - scrollTop).toBe(onScreen);
  }
  // at the cap the list's height stays level, yet the place moves down with every row that comes on top
  expect(scrollTop).toBeGreaterThan(600);
});
