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
