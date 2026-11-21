// Every state machine of CONTRACT §1: each pair of states is either in the contract's table or refused
// with illegal_state naming the current state.
import { describe, expect, it } from "bun:test";
import {
  ACTIVITY_TRANSITIONS,
  CALL_TERMINAL,
  CALL_TRANSITIONS,
  CONTROL_TRANSITIONS,
  EPISODE_TRANSITIONS,
  LINK_TRANSITIONS,
  PROGRAM_TRANSITIONS,
  PROVIDER_TRANSITIONS,
} from "../../protocol/types.ts";
import { ToolFail, assertTransition } from "../src/envelope.ts";

const TABLES: Record<string, Record<string, readonly string[]>> = {
  link: LINK_TRANSITIONS,
  activity: ACTIVITY_TRANSITIONS,
  control: CONTROL_TRANSITIONS,
  episode: EPISODE_TRANSITIONS,
  provider: PROVIDER_TRANSITIONS,
  program: PROGRAM_TRANSITIONS,
  call: CALL_TRANSITIONS,
};

describe("state machines", () => {
  for (const [name, table] of Object.entries(TABLES))
    it(`${name}: legal transitions pass, every other one is illegal_state`, () => {
      const states = Object.keys(table);
      let illegal = 0;
      for (const from of states)
        for (const to of states) {
          if (table[from]!.includes(to)) {
            expect(() => assertTransition(name, table, from, to)).not.toThrow();
            continue;
          }
          illegal++;
          let thrown: unknown;
          try {
            assertTransition(name, table, from, to);
          } catch (e) {
            thrown = e;
          }
          expect(thrown).toBeInstanceOf(ToolFail);
          expect((thrown as ToolFail).code).toBe("illegal_state");
          expect((thrown as ToolFail).message).toContain(`current state is ${from}`);
          expect((thrown as ToolFail).toError().retryable).toBe(false);
        }
      expect(illegal).toBeGreaterThan(0);
    });

  it("the call table agrees with the contract: terminal states have no exit, the others reach one", () => {
    for (const s of CALL_TERMINAL) expect(CALL_TRANSITIONS[s]).toEqual([]);
    expect(CALL_TRANSITIONS.received).toEqual(["rejected", "deduplicated", "queued", "dispatched"]);
    expect(CALL_TRANSITIONS.dispatched).toEqual(["completed", "failed", "timed_out", "preempted"]);
    expect(CALL_TRANSITIONS.queued).toContain("dispatched");
  });
});
