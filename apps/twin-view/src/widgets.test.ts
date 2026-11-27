import { describe, expect, test } from "bun:test";
import type { SensorState } from "./messages";
import { compass, gauge, sensorWidget } from "./widgets";

const s = (kind: SensorState["kind"], mode: number, values: number[]): SensorState => ({
  port: "1",
  kind,
  mode,
  values,
});

describe("widgets invent no value and keep every number in reach", () => {
  test("an empty port gets no widget; a mode without values says so", () => {
    expect(sensorWidget(s(null, 0, []), "")).toBe("");
    expect(sensorWidget(s("ultrasonic", 0, []), "distancia")).toContain("sin dato");
  });
  test("the ultrasonic's 255 is no echo, not a distance; a reading keeps its number", () => {
    expect(sensorWidget(s("ultrasonic", 0, [255]), "distancia")).toContain("sin eco");
    const near = sensorWidget(s("ultrasonic", 0, [17.3]), "distancia");
    expect(near).toContain("17.3 cm");
    expect(near).toContain('title="distancia: 17.3');
  });
  test("reflected light is a grey of its brightness, never a colour's name; colour mode names it", () => {
    const light = sensorWidget(s("color", 0, [85]), "luz reflejada");
    expect(light).toContain("85 %");
    expect(light).not.toContain("blanco");
    expect(sensorWidget(s("color", 2, [5]), "color")).toContain("rojo");
  });
  test("touch is a dot lit when pressed; the gyro a needle counter-clockwise", () => {
    expect(sensorWidget(s("touch", 0, [1]), "presión")).toContain("w-dot on");
    expect(sensorWidget(s("touch", 0, [0]), "presión")).not.toContain("w-dot on");
    expect(compass(90, "")).toContain("rotate(-90 12 12)");
    expect(sensorWidget(s("gyro", 0, [-35]), "ángulo")).toContain("-35°");
  });
  test("a gauge clamps its needle, not its title", () => {
    const g = gauge(140, "velocidad 140 %");
    expect(g).toContain("100 %");
    expect(g).toContain('title="velocidad 140 %"');
  });
});
