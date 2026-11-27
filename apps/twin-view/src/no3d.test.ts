import { expect, test } from "bun:test";
import { no3dText } from "./no3d";

test("without WebGL the page says why and how to fix it, in Spanish", () => {
  expect(no3dText("no_context")).toContain("no pudo iniciar los gráficos 3D (WebGL)");
  expect(no3dText("no_context")).toContain("chrome://settings/system");
  expect(no3dText("lost")).toContain("no los devolvió");
});
