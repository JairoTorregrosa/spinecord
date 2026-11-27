import { describe, expect, test } from "bun:test";
import { draftLines, unconfirmedOf } from "./draft";
import type { RobotMeta } from "./messages";

const meta = (look: Record<string, unknown> | null): RobotMeta =>
  ({
    id: "r1-sim",
    name: null,
    drivetrain: null,
    ports: { motors: { B: "large" }, sensors: { "4": "ultrasonic" } },
    world: { look } as RobotMeta["world"],
  }) as RobotMeta;

describe("the draft chip's list", () => {
  test("nothing when the list is absent or empty", () => {
    expect(draftLines(meta(null))).toEqual([]);
    expect(draftLines(meta({}))).toEqual([]);
    expect(draftLines(meta({ unconfirmed: [] }))).toEqual([]);
  });
  test("one plain line per entry, naming what the file says is on a port", () => {
    expect(draftLines(meta({ unconfirmed: ["B", "C", "S4", "S1", "front", "wheel_diameter", "places"] }))).toEqual([
      "Puerto B: motor grande",
      "Puerto C: vacío",
      "Puerto 4: sensor ultrasónico",
      "Puerto 1: vacío",
      "Cuál es el frente del robot",
      "El diámetro de las ruedas",
      "Dónde van el ladrillo, los sensores y el teléfono",
    ]);
  });
  test("a list that is not a list of strings shows nothing invented", () => {
    expect(unconfirmedOf(meta({ unconfirmed: "front" }))).toEqual([]);
    expect(unconfirmedOf(meta({ unconfirmed: ["front", 3] }))).toEqual(["front"]);
  });
});
