import { expect, test } from "bun:test";
import { glance, shortArgs } from "./toolwords";

test("a call at a glance: icon, the tool in the person's words, one value; the same in the list and the chat", () => {
  expect(glance("drive", '{"robot_id":"r1-sim","distance_cm":30,"speed_pct":40}')).toBe(
    '<span class="ic" aria-hidden="true">⬆</span><b>avanzar</b><span class="one">30 cm · 40%</span>',
  );
  // a tool the page has no words for keeps its MCP name; cut arguments that are no JSON show no value
  expect(glance("new_tool", '{"a":1')).toBe('<span class="ic" aria-hidden="true">⚙</span><b>new_tool</b>');
  expect(glance("turn", null)).toBe('<span class="ic" aria-hidden="true">↻</span><b>girar</b>');
  expect(shortArgs('{"robot_id":"x","device":"<b>"}')).toBe("<b>");
  expect(glance("command_device", '{"device":"<b>"}')).toContain("&lt;b&gt;");
});
