import { describe, expect, test } from "bun:test";
import { summarize } from "../src/tools";

const robot = { id: "r1-sim", backend: "sim" as const, link: "online" as const, activity: "idle" as const };

describe("the summary line", () => {
  test("a note is on the summary line, so a reader of the text alone sees that nothing moved", () => {
    const line = summarize("turn", {
      ok: true,
      tool: "turn",
      data: { reason: "completed", note: "angle_deg 0.2 is below the smallest turn (0.47°): nothing moved" },
      robot,
      next: [],
    } as never);
    expect(line).toContain("reason=completed");
    expect(line).toContain("note: angle_deg 0.2 is below the smallest turn (0.47°): nothing moved");
    expect(line).not.toContain("\n");
  });
  test("a result without a note has no note on its summary line", () => {
    const line = summarize("turn", { ok: true, tool: "turn", data: { reason: "completed" }, robot, next: [] } as never);
    expect(line).not.toContain("note");
  });
});
