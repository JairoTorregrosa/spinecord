// The distance sensors' eyes for the server, from the LEGO parts map read at run time (no Bun macro: the page's
// dims.ts reads the same map when the page is built). Each sensor's box and named points go into its own frame as
// dims.ts puts them ("front": x = -LDraw Z, y = LDraw X, z = -LDraw Y), and the eye from the box's centre comes
// from sensor-pose.ts, the one rule the page uses too.
import { legoMap } from "../../twin-view/src/lego";
import { eyeOffset, type DistanceKind, type EyeOffset } from "../../twin-view/src/sensor-pose";

let map: ReturnType<typeof legoMap> | null = null;
const lego = () => (map ??= legoMap());

/** The LEGO module, cm. */
export const moduleCm = (): number => lego().module_mm / 10;

/** Where a distance sensor's eye is from the centre of its box, cm (sensor-pose.ts eyeOffset). */
export function sensorEye(kind: DistanceKind): EyeOffset {
  const L = lego();
  const ldu = L.ldu_mm / 10;
  const p = kind === "ir" ? L.infrared : L.ultrasonic;
  const front = (q: readonly number[]): number[] => [-q[2]! * ldu, q[0]! * ldu, -q[1]! * ldu];
  const a = front(p.bbox.min),
    b = front(p.bbox.max);
  return eyeOffset(kind, {
    min: a.map((v, i) => Math.min(v, b[i]!)),
    max: a.map((v, i) => Math.max(v, b[i]!)),
    at: Object.fromEntries(Object.entries(p.features).map(([k, f]) => [k, front(f.at)])),
  });
}
