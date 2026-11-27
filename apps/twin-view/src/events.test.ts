import { expect, test } from "bun:test";
import { eventRow } from "./events";

test("pushes, collisions and box changes become one icon and a few words; endings give no row", () => {
  expect(eventRow({ n: 1, t_ms: 0, kind: "push_ended", box: "cup", moved_cm: 4.26 })).toEqual({
    icon: "📦",
    text: "cup se movió 4,3 cm",
  });
  expect(eventRow({ n: 2, t_ms: 0, kind: "contact_began", with: "wall_north" })).toEqual({
    icon: "💥",
    text: "toca pared norte",
  });
  expect(eventRow({ n: 3, t_ms: 0, kind: "contact_began", with: "box2" })!.text).toBe("toca caja box2");
  expect(eventRow({ n: 4, t_ms: 0, kind: "obstacle_changed", box: "box2", change: "removed" })).toEqual({
    icon: "➖",
    text: "box2 quitada",
  });
  expect(eventRow({ n: 5, t_ms: 0, kind: "contact_ended", with: "box2" })).toBeNull();
  expect(eventRow({ n: 6, t_ms: 0, kind: "echo_lost", why: "slant" })).toBeNull();
});
