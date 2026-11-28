import { expect, test } from "bun:test";
import { no3dText } from "./no3d";

test("without WebGL the page says why and how to fix it, in Spanish", () => {
  expect(no3dText("no_context")).toContain("no pudo iniciar los gráficos 3D (WebGL)");
  expect(no3dText("no_context")).toContain("chrome://settings/system");
  expect(no3dText("lost")).toContain("no los devolvió");
});

test("a robot the page cannot draw as the twin reads it says so, with the reason", () => {
  expect(no3dText("build", "the eye is at (1, 2, 3)")).toContain(
    "no se pudo dibujar como lo lee el gemelo: the eye is at (1, 2, 3)",
  );
});
