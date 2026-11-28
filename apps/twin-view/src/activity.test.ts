import { expect, test } from "bun:test";
import {
  CallsScroller,
  Follow,
  GLIDE_MS,
  HOLD_CALLS,
  MAX_CALLS,
  RESUME_MS,
  ScrollOwner,
  isClaudeCall,
  type ListPort,
} from "./activity";
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

/**
 * A list like the page's: rows of fractional heights, newest first, a viewport of 200 px, and a scroll position the
 * setter rounds to whole pixels and clamps, as Chrome does. Each change of `top` queues a scroll event; `flush`
 * delivers them as the browser does after the task.
 */
class FakeList implements ListPort<{ n: number; h: number }> {
  list: { n: number; h: number }[] = [];
  private _top = 0;
  pending = false;
  readonly view = 200;
  get top(): number {
    return this._top;
  }
  set top(v: number) {
    const next = Math.max(0, Math.min(Math.round(v), Math.round(Math.max(0, this.full() - this.view))));
    if (next !== this._top) this.pending = true;
    this._top = next;
  }
  full(): number {
    return this.list.reduce((a, r) => a + r.h, 0);
  }
  rows() {
    return this.list;
  }
  offset(r: { n: number; h: number }): number {
    let y = 0;
    for (const x of this.list) {
      if (x === r) return y;
      y += x.h;
    }
    throw new Error("no such row");
  }
  relTop(r: { n: number; h: number }): number {
    return this.offset(r) - this._top;
  }
  height(r: { n: number; h: number }): number {
    return r.h;
  }
  drop(r: { n: number; h: number }): void {
    this.list = this.list.filter((x) => x !== r);
  }
  /** The person scrolls the list to `v`. */
  personTo(v: number): void {
    this.top = v;
  }
}

function rig() {
  let now = 0;
  const list = new FakeList();
  const s = new CallsScroller(list, () => now);
  let n = 0;
  /** One new call on top, then the scroll events the browser delivers. */
  const call = () => {
    s.change(() => {
      list.list.unshift({ n: n, h: 26.546875 + (n % 3) * 0.3 });
      n++;
      return true;
    });
    flush();
  };
  const flush = () => {
    if (list.pending) {
      list.pending = false;
      s.scrolled();
    }
  };
  return {
    s,
    list,
    call,
    flush,
    at: (t: number) => (now = t),
  };
}

test("wiring: from the first call on the list shows the newest, its own scrolls never start reading", () => {
  const r = rig();
  for (let i = 0; i < 150; i++) r.call();
  expect(r.list.top).toBe(0);
  expect(r.s.follow.following).toBe(true);
  expect(r.list.list.length).toBe(MAX_CALLS);
});

test("a finger held still before it drags: the drag is the person's, and the next calls keep the place", () => {
  const r = rig();
  for (let i = 0; i < 40; i++) r.call();
  r.s.input("start"); // pressed at the top
  r.at(700);
  r.s.input("move");
  r.list.personTo(300); // 700 ms later the drag
  r.flush();
  expect(r.s.follow.following).toBe(false);
  r.call();
  expect(r.s.follow.following).toBe(false);
  expect(r.s.follow.unseen).toBe(1);
  expect(r.list.top).toBeGreaterThan(300);
});

test("a long drag keeps reading however long it lasts; the wait starts when the person lets go", () => {
  const r = rig();
  for (let i = 0; i < 40; i++) r.call();
  r.s.input("start");
  r.list.personTo(200);
  r.flush();
  for (let t = 0; t <= 15_000; t += 500) {
    r.at(t);
    r.s.input("move");
    expect(r.s.tick()).toBe(false);
    r.call();
  }
  r.s.input("end");
  r.at(15_000 + RESUME_MS - 1);
  expect(r.s.tick()).toBe(false);
  r.at(15_000 + RESUME_MS);
  expect(r.s.tick()).toBe(true);
  r.flush();
  expect(r.list.top).toBe(0);
  expect(r.s.follow.following).toBe(true);
});

test("rows of fractional heights, a scroll the browser rounds: the row read stays within 1 px over 100 calls", () => {
  const r = rig();
  for (let i = 0; i < 60; i++) r.call();
  r.list.personTo(600);
  r.flush();
  r.s.change(() => false); // the anchor is taken
  const row = r.list.list.find((x) => r.list.relTop(x) + x.h > 0)!;
  const left = r.list.relTop(row);
  for (let i = 0; i < 100; i++) {
    r.at(i * 100);
    r.call();
    expect(Math.abs(r.list.relTop(row) - left)).toBeLessThanOrEqual(1);
  }
  expect(r.s.follow.following).toBe(false);
});

test("at the cap, the rows the person reads are not trimmed under them; following again trims back", () => {
  const r = rig();
  for (let i = 0; i < MAX_CALLS; i++) r.call();
  // reading the oldest rows, at the bottom of the list
  r.list.personTo(r.list.full());
  r.flush();
  const oldest = r.list.list.at(-1)!;
  for (let i = 0; i < 60; i++) {
    r.at(i * 100);
    r.call();
  }
  expect(r.list.list.includes(oldest)).toBe(true);
  expect(r.list.list.length).toBe(MAX_CALLS + 60);
  for (let i = 0; i < HOLD_CALLS; i++) r.call();
  expect(r.list.list.length).toBe(HOLD_CALLS);
  r.list.personTo(0);
  r.flush();
  expect(r.s.follow.following).toBe(true);
  expect(r.list.list.length).toBe(MAX_CALLS);
});

test("folding ends reading; opening shows the newest call", () => {
  const r = rig();
  for (let i = 0; i < 40; i++) r.call();
  r.list.personTo(300);
  r.flush();
  r.call();
  r.s.folded(true);
  expect(r.s.follow.following).toBe(true);
  expect(r.s.follow.unseen).toBe(0);
  r.s.folded(false);
  expect(r.list.top).toBe(0);
});

test('the smooth return of "↑ N nuevas" is the page\'s, for GLIDE_MS at most', () => {
  const r = rig();
  for (let i = 0; i < 40; i++) r.call();
  r.list.personTo(500);
  r.flush();
  r.at(1000);
  r.s.toNewest();
  r.list.top = 300; // midway, the page's own glide
  r.flush();
  expect(r.s.follow.following).toBe(true);
  // the glide was cut by something that is no input: past GLIDE_MS a scroll is the person's again
  r.at(1000 + GLIDE_MS + 1);
  r.list.personTo(400);
  r.flush();
  expect(r.s.follow.following).toBe(false);
});

test("the person's wheel interrupts the page's glide at once", () => {
  const o = new ScrollOwner();
  o.glide(0, 0);
  expect(o.byPage(300, 10)).toBe(true);
  o.personActs();
  expect(o.byPage(250, 20)).toBe(false);
});
