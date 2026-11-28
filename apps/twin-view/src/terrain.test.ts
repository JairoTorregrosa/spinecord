import { expect, test } from "bun:test";
import { cornerHeights, heightAt, pieceLabel, slopeDeg, terrainWords } from "./terrain";
import type { TerrainPiece } from "./messages";

const ramp: TerrainPiece = {
  id: "subida",
  kind: "ramp",
  x: 0,
  y: 0,
  w: 50,
  h: 40,
  low_cm: 0,
  high_cm: 12,
  rises: "east",
};

test("a piece's corners, slope and label: what the 3D view draws and writes on it", () => {
  expect(cornerHeights(ramp)).toEqual([0, 12, 12, 0]);
  expect(cornerHeights({ ...ramp, rises: "north" })).toEqual([0, 0, 12, 12]);
  expect(cornerHeights({ ...ramp, kind: "platform", low_cm: 5, high_cm: 5, rises: undefined })).toEqual([5, 5, 5, 5]);
  expect(slopeDeg(ramp)).toBeCloseTo(13.5, 1);
  expect(pieceLabel(ramp)).toBe("subida · 0 cm → 12 cm · 13°");
  expect(pieceLabel({ id: "cima", kind: "platform", x: 0, y: 0, w: 1, h: 1, low_cm: 21.7, high_cm: 21.7 })).toBe(
    "cima · 21,7 cm",
  );
});

test("the height under a point, so the trail lies on the terrain", () => {
  const top: TerrainPiece = { id: "p", kind: "platform", x: 50, y: 0, w: 20, h: 40, low_cm: 12, high_cm: 12 };
  expect(heightAt([ramp, top], 25, 10)).toBeCloseTo(6, 9);
  expect(heightAt([ramp, top], 60, 10)).toBe(12);
  expect(heightAt([ramp, top], 80, 10)).toBe(0);
});

test("the chip and the labels name a piece and a height as a person reads them", () => {
  expect(terrainWords({ fallen: { from: "orilla_b", drop_cm: 12, tilt_deg: 40 }, block: null })).toBe(
    "Se cayó de orilla b: ponlo de pie o restaura el mundo",
  );
  expect(terrainWords({ fallen: null, block: { by: "step", with: "escalon_alto", rise_cm: 2.5 } })).toBe(
    "Escalón muy alto en escalon alto (2,5 cm): rodéalo",
  );
  expect(pieceLabel({ id: "orilla_b", kind: "platform", x: 0, y: 0, w: 30, h: 60, low_cm: 12, high_cm: 12 })).toBe(
    "orilla b · 12 cm",
  );
});
