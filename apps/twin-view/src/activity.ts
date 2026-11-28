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
// Only the person's own input (wheel, pointer, touch, key) starts reading or keeps it; a scroll the page makes
// itself never does, so a steady stream of calls cannot keep the list off the newest for ever.
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
  reset(): void {
    this.state = { kind: "following" };
  }
}
