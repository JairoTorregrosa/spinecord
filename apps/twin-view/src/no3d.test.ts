import { expect, test } from "bun:test";
import { NO3D_START, no3dNext, no3dShown, no3dText, type No3dEvent } from "./no3d";

const run = (...events: No3dEvent[]) => events.reduce(no3dNext, NO3D_START);
const shown = (...events: No3dEvent[]) => no3dShown(run(...events)).why;

test("without WebGL the page says why and how to fix it, in Spanish", () => {
  expect(no3dText("no_context")).toContain("no pudo iniciar los gráficos 3D (WebGL)");
  expect(no3dText("no_context")).toContain("chrome://settings/system");
  expect(no3dText("lost")).toContain("no los devolvió");
});

test("a robot the page cannot draw: plain Spanish, whom to tell; the English detail only in the title", () => {
  expect(no3dText("build")).toBe(
    "Esta página no pudo dibujar este robot. Avísale a quien te pasó esta página: el resto de la página sigue funcionando.",
  );
  const s = no3dShown(run({ t: "build_failed", detail: "the eye is at (1, 2, 3)" }));
  expect(s).toEqual({ why: "build", detail: "the eye is at (1, 2, 3)" });
});

test("a build's reason clears only when a robot builds, or there is none to build", () => {
  const failA: No3dEvent = { t: "build_failed", detail: "robot A" };
  expect(shown(failA)).toBe("build");
  // switching to robot B that builds, or A rebuilt fixed: gone
  expect(shown(failA, { t: "built" })).toBe("none");
  // B fails too: B's reason, not A's
  expect(no3dShown(run(failA, { t: "build_failed", detail: "robot B" })).detail).toBe("robot B");
  // the context coming back does not hide a robot that could not be drawn
  expect(shown(failA, { t: "lost", detail: "gpu" })).toBe("lost");
  expect(shown(failA, { t: "lost", detail: "gpu" }, { t: "restored" })).toBe("build");
  expect(shown({ t: "lost", detail: "gpu" }, { t: "restored" })).toBe("none");
});

test("the browser's 3D comes first, and a page that never had it keeps saying so", () => {
  expect(shown({ t: "no_context", detail: "x" }, { t: "built" })).toBe("no_context");
  expect(shown({ t: "no_context", detail: "x" }, { t: "lost", detail: "y" }, { t: "restored" })).toBe("no_context");
  expect(shown({ t: "restored" })).toBe("none"); // a restore without a loss changes nothing
});
