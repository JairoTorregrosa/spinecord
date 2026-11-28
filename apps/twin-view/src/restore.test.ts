import { expect, test } from "bun:test";
import { restoredText } from "./restore";

test("the restore toast names the gyro only on a robot that has one, in plain words", () => {
  const withGyro = restoredText({
    ports: { motors: { B: "large", C: "large" }, sensors: { "1": "touch", "2": "gyro" } },
  });
  const without = restoredText({ ports: { motors: { B: "large", C: "large" }, sensors: { "3": "ultrasonic" } } });
  expect(withGyro).toBe(
    "Listo: la sala quedó como al principio y el robot volvió a la salida, con el giroscopio en cero.",
  );
  expect(without).toBe("Listo: la sala quedó como al principio y el robot volvió a la salida.");
  for (const t of [withGyro, without]) expect(t).not.toMatch(/odometr|tacho|encoder|pose/i);
});

test("a robot left in fault: the toast says the room is back but the fault stays, and how it ends", () => {
  const meta = { ports: { motors: {}, sensors: { "2": "gyro" as const } } };
  expect(restoredText(meta, "fault")).toBe(
    "La sala quedó como al principio, pero el robot sigue en falla: pídele a Claude que le quite la falla (reset_fault).",
  );
  expect(restoredText(meta, "idle")).toBe(restoredText(meta));
});
