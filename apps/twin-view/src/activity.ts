// The activity panel: which messages it lists, and whether it follows the newest one. Pure, so it is tested
// without a page; hud.ts draws it.
//
// The panel lists the MCP tool calls Claude makes and nothing else: what the person does by hand (carry the robot,
// put or take a box, press a brick button) and what the world reports (a push, a contact) stay out of it.
//
// The list has the newest call on top. It follows by default: each new call shows at the top without a scroll.
// Follow state machine:
//   following --(the person scrolls away from the top)--> reading
//   reading --(the person scrolls back to the top)--> following
//   reading --(RESUME_MS without the person touching the list)--> following (the list jumps to the newest)
//   reading --(the panel folded)--> following
//   reading --("↑ N nuevas")--> following
// Every scroll is the person's unless the page made it (ScrollOwner): only the person's scrolls, and their pointer
// or finger moving on the list, start reading or restart its wait; the page's own scrolls (keeping the place, the
// return to the top) never do, so a steady stream of calls cannot keep the list off the newest for ever. Folding
// the panel ends reading: nothing of the list is visible, and it opens on the newest call. While the person reads,
// the oldest rows wait to be trimmed (up to HOLD_CALLS), so the rows they read do not vanish under them.
import type { CallEnd, CallStart, ServerMessage } from "./messages";

/** A message the activity panel lists: the start or end of an MCP tool call. */
export function isClaudeCall(m: ServerMessage): m is CallStart | CallEnd {
  return m.t === "call_start" || m.t === "call_end";
}

/** How long the list stays where the person left it before it returns to the newest call, ms. */
export const RESUME_MS = 10_000;

export type FollowState = { kind: "following" } | { kind: "reading"; touchedAt: number; unseen: number };

export class Follow {
  state: FollowState = { kind: "following" };

  get following(): boolean {
    return this.state.kind === "following";
  }
  get unseen(): number {
    return this.state.kind === "reading" ? this.state.unseen : 0;
  }
  /** A new row on top. True: show the top (follow); false: keep the place the person reads. */
  added(): boolean {
    if (this.state.kind === "following") return true;
    this.state.unseen++;
    return false;
  }
  /** The person's own input on the list (wheel, pointer, touch, key), with where the list now is. */
  touched(atNewest: boolean, now: number): void {
    if (atNewest) this.state = { kind: "following" };
    else if (this.state.kind === "reading") this.state.touchedAt = now;
    else this.state = { kind: "reading", touchedAt: now, unseen: 0 };
  }
  /** The list scrolled, by the person or by the page: back at the top it follows again; nothing else changes. */
  scrolled(atNewest: boolean): void {
    if (atNewest) this.state = { kind: "following" };
  }
  /** Called often. True when reading has lasted RESUME_MS untouched: the list follows again and must show the top. */
  tick(now: number): boolean {
    if (this.state.kind !== "reading" || now - this.state.touchedAt < RESUME_MS) return false;
    this.state = { kind: "following" };
    return true;
  }
  /** The panel is folded: reading ends. True when it did, and the list must show the top. */
  folded(): boolean {
    if (this.state.kind !== "reading") return false;
    this.state = { kind: "following" };
    return true;
  }
  reset(): void {
    this.state = { kind: "following" };
  }
}

/** How long a smooth scroll the page starts may take before a scroll that is not at its target is the person's, ms. */
export const GLIDE_MS = 1000;

/**
 * Tells the scrolls the page makes apart from the person's. The page notes the place it set (`set`); a scroll that
 * lands there is the page's, any other is the person's. A place the page set that brought no scroll (the list was
 * already there) is forgotten by the next scroll, which is then the person's. `glide` covers a smooth scroll the
 * page starts: every scroll until it reaches its target, for at most GLIDE_MS, is the page's.
 */
export class ScrollOwner {
  private expected: number | null = null;
  private gliding: { target: number; until: number } | null = null;
  set(top: number): void {
    this.expected = top;
  }
  glide(target: number, now: number): void {
    this.gliding = { target, until: now + GLIDE_MS };
  }
  /** A scroll happened and the list is at `top`: true when the page made it. */
  byPage(top: number, now: number): boolean {
    if (this.gliding && now > this.gliding.until) this.gliding = null;
    if (this.gliding) {
      if (Math.abs(top - this.gliding.target) < 1) this.gliding = null;
      return true;
    }
    const mine = this.expected !== null && Math.abs(top - this.expected) < 1;
    this.expected = null;
    return mine;
  }
  /** The person took over (wheel, pointer, finger): a glide the page started is theirs to interrupt. */
  personActs(): void {
    this.gliding = null;
  }
}

/** The rows the list keeps while it follows; while the person reads, the oldest wait to go, up to HOLD_CALLS. */
export const MAX_CALLS = 80;
export const HOLD_CALLS = 200;

/** What CallsScroller needs of the list on the page; a test hands it a fake. Rows are newest first. */
export interface ListPort<R> {
  /** The list's scroll position; the page's setter may round it (Chrome keeps whole pixels). */
  top: number;
  rows(): readonly R[];
  /** A row's top relative to the list's top edge, at the current scroll. */
  relTop(r: R): number;
  height(r: R): number;
  /** Removes an old row from the list. */
  drop(r: R): void;
}

/**
 * The scroll of the activity list: follow or read (Follow), whose scroll each one is (ScrollOwner), and the row the
 * person reads held still. The anchor is the first row they see and where they left it, kept as long as that row
 * stays and reset only by their own scroll, so the page's rounding of each place it sets never adds up.
 */
export class CallsScroller<R> {
  readonly follow = new Follow();
  readonly owner = new ScrollOwner();
  private anchor: { row: R; at: number } | null = null;
  private held = false;
  constructor(
    private readonly list: ListPort<R>,
    private readonly now: () => number,
  ) {}

  /** Rows came, went or grew: `change` does it and says whether a new row came on top. */
  change(change: () => boolean): void {
    if (!this.follow.following && !this.anchor) this.anchor = this.pick();
    const added = change();
    const show = added ? this.follow.added() : this.follow.following;
    this.trim();
    if (show) this.setTop(0);
    else if (this.anchor) this.setTop(this.list.top + this.list.relTop(this.anchor.row) - this.anchor.at);
  }
  /** The list scrolled. */
  scrolled(): void {
    const top = this.list.top;
    if (this.owner.byPage(top, this.now())) this.follow.scrolled(top <= 4);
    else {
      this.follow.touched(top <= 4, this.now());
      this.anchor = null; // the person moved: their place is where they are now
    }
    if (this.follow.following) this.settle();
  }
  /** The person's wheel, pointer, finger or key on the list: `start`, `move`, `end`. */
  input(kind: "start" | "move" | "end"): void {
    if (kind === "start") {
      this.owner.personActs();
      this.held = true;
    }
    if (kind === "end") this.held = false;
    else if ((kind === "start" || this.held) && this.list.top > 4) this.follow.touched(false, this.now());
  }
  /** "↑ N nuevas": back to the newest call, smoothly. Returns the target for the page's smooth scroll. */
  toNewest(): number {
    this.follow.reset();
    this.settle();
    this.owner.glide(0, this.now());
    return 0;
  }
  /** The panel folded or opened. Folded ends reading; opened shows the newest call. */
  folded(folded: boolean): void {
    if (folded) {
      if (this.follow.folded()) this.settle();
    } else if (this.follow.following) this.setTop(0);
  }
  /** Called often: true when the list went back to the newest call by itself (RESUME_MS untouched). */
  tick(): boolean {
    if (!this.follow.tick(this.now())) return false;
    this.settle();
    this.setTop(0);
    return true;
  }
  reset(): void {
    this.follow.reset();
    this.anchor = null;
  }

  private setTop(top: number): void {
    this.list.top = top;
    this.owner.set(this.list.top);
  }
  private pick(): { row: R; at: number } | null {
    for (const r of this.list.rows()) {
      const at = this.list.relTop(r);
      if (at + this.list.height(r) > 0) return { row: r, at };
    }
    return null;
  }
  /** Following again: no anchor, and the rows held while reading go. */
  private settle(): void {
    this.anchor = null;
    this.trim();
  }
  private trim(): void {
    const cap = this.follow.following ? MAX_CALLS : HOLD_CALLS;
    const rows = this.list.rows();
    for (let i = rows.length - 1; i >= cap; i--) {
      if (this.anchor?.row === rows[i]) this.anchor = null;
      this.list.drop(rows[i]!);
    }
  }
}
