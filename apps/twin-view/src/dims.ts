// Every real dimension the 3D robot is drawn with, in cm, taken from the LEGO parts map (packages/lego-parts,
// read at build time by ./lego.ts), each part in its own frame. No size is typed here: a wrong size is fixed in
// the map, with its source, and the page follows. The only numbers that are not LEGO's are the phone's and the
// flat cable's section, both marked.
//
// A part's frame here: x along where it faces or runs (a sensor's eye, a motor's body), y to its left, z up, cm.
// The map gives positions in the part's LDraw frame (LDU, -Y up); `fromLdraw` turns them into this frame, and
// `LDRAW_TO_LOCAL` is the same map as a matrix for the real meshes.
import { legoMap } from "./lego" with { type: "macro" };

const L = legoMap();
type V3 = [number, number, number];

/** cm per LDU (0.04). */
export const LDU = L.ldu_mm / 10;
/** The LEGO module: 0.8 cm between studs and between Technic holes. */
export const MODULE = L.module_mm / 10;
export const PLATE = L.plate_mm / 10;
/** A thick beam: one module along its holes, 0.72 across them, holes Ø 0.48. */
export const BEAM = { along: L.beam_mm / 10, across: L.beam_across_ldu * LDU, hole: L.pin_hole_mm / 10 };
export const STUD = { d: L.stud_d_mm / 10, h: L.stud_h_mm / 10 };
export const AXLE = L.axle_cross_mm / 10;

/** How a part's LDraw axes map to its frame here. "brick": x toward the screen end (LDraw +Z), y to the left
 *  (LDraw -X), z up from its bottom; "front": the part faces or runs along LDraw -Z (every EV3 motor and sensor:
 *  the eye, the plunger, the output), so x = -Z, y = X, z = -Y, from the part's own LDraw origin (its axle hole,
 *  or a motor's output). */
export type Frame = "brick" | "front";
export function fromLdraw(frame: Frame, p: readonly number[], bottom = 0): V3 {
  const [x, y, z] = p as V3;
  return frame === "brick" ? [z * LDU, -x * LDU, (bottom - y) * LDU] : [-z * LDU, x * LDU, -y * LDU];
}
/** The same as a 4 × 4 column-major matrix from LDU to cm (three.js Matrix4.fromArray), in robot-style axes. */
export function ldrawMatrix(frame: Frame, bottom = 0): number[] {
  const s = LDU;
  // columns: where LDraw X, Y, Z go; then the translation
  return frame === "brick"
    ? [0, -s, 0, 0, 0, 0, -s, 0, s, 0, 0, 0, 0, 0, bottom * s, 1]
    : [0, s, 0, 0, 0, 0, -s, 0, -s, 0, 0, 0, 0, 0, 0, 1];
}

/** A part's box in its frame (cm), and where its named features are. */
export interface PartDims {
  ldraw: string;
  min: V3;
  max: V3;
  /** feature name → position (cm, the part's frame) */
  at: Record<string, V3>;
  /** its Technic holes: centre and axis in the part's frame */
  holes: { kind: "pin" | "axle"; at: V3; axis: V3 }[];
}
function part(frame: Frame, p: (typeof L)["brick"], bottom = 0): PartDims {
  const a = fromLdraw(frame, p.bbox.min, bottom),
    b = fromLdraw(frame, p.bbox.max, bottom);
  return {
    ldraw: p.ldraw,
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
    at: Object.fromEntries(Object.entries(p.features).map(([k, f]) => [k, fromLdraw(frame, f.at, bottom)])),
    holes: p.holes.map((h) => ({
      kind: h.kind as "pin" | "axle",
      at: fromLdraw(frame, h.at, bottom),
      axis: fromLdraw(frame, h.axis).map((v) => Math.round(Math.abs(v / LDU) * 1000) / 1000) as V3,
    })),
  };
}

/** The EV3 brick, its bottom at z = 0: 11.12 × 7.2 × 4.36 cm with the AA cover, 5.08 with the rechargeable battery
 *  (whose tray hangs lower; the top and the ports stay where they are). */
const brickBottom = L.brick.bbox.max[1]!,
  rechargeableBottom = L.brickRechargeable.bbox.max[1]!;
export const BRICK = {
  aa: part("brick", L.brick, brickBottom),
  rechargeable: part("brick", L.brickRechargeable, rechargeableBottom),
  /** The LCD (11036): across the brick and along it, centred on the `screen` feature. */
  screen: { across: L.brick.specs.screen_across_mm! / 10, along: L.brick.specs.screen_along_mm! / 10 },
  /** The white top shell reaches this far down from the top; the light grey bottom shell is below. */
  topShell: (L.brick.specs.top_shell_bottom_ldu! - L.brick.bbox.min[1]!) * LDU,
  /** LDraw Y of the bottom (AA, rechargeable): the matrix's offset. */
  bottomLdu: { aa: brickBottom, rechargeable: rechargeableBottom },
};

export const MOTOR = {
  /** The large motor (45502), from its output's centre: the body runs back along +x, 10.72 long, 4.0 wide, 5.52
   *  high; the red hub turns about y, Ø 2.32 and 2.4 wide, through the case. */
  large: {
    ...part("front", L.largeMotor),
    hub: { d: L.largeMotor.specs.hub_diameter_mm! / 10, w: L.largeMotor.specs.hub_width_mm! / 10 },
  },
  /** The medium motor (45503), from its output's centre: the output faces +x, the body behind it. */
  medium: {
    ...part("front", L.mediumMotor),
    hub: { d: L.mediumMotor.specs.hub_diameter_mm! / 10, l: L.mediumMotor.specs.hub_length_mm! / 10 },
  },
};
// the large motor's output turns about LDraw X, which is y here: say so where a reader expects x
if (L.largeMotor.features.output?.dir?.[0] !== 1) throw new Error("the large motor's output does not turn about X");

/** The sensors, from their axle hole (the mount through the body, across): the eye or face looks along +x. */
export const SENSOR = {
  touch: part("front", L.touch),
  color: part("front", L.color),
  ultrasonic: part("front", L.ultrasonic),
  gyro: part("front", L.gyro),
  ir: part("front", L.infrared),
};

/** A tyre on its rim: outer Ø and width, the rim's Ø, cm. */
export interface Wheel {
  part: string;
  d: number;
  w: number;
  rim: number;
  rimPart: string;
}
/** The tyres an EV3 set has, each on its rim (./lego.ts lists both in pairs: the map's `fits`, 44771 on 15038 by
 *  its name). */
export const WHEELS: Wheel[] = L.tyres.map((t, i) => {
  const rim = L.rims[i]!;
  return { part: t.part, d: t.diameter! / 10, w: t.width / 10, rim: rim.diameter! / 10, rimPart: rim.part };
});
/** The real wheel whose tyre is nearest the profile's wheel diameter. */
export const wheelFor = (diameterCm: number): Wheel =>
  WHEELS.reduce((best, w) => (Math.abs(w.d - diameterCm) < Math.abs(best.d - diameterCm) ? w : best));

/** The two kinds of EV3 track. */
export const TRACKS = {
  /** The home set's (31313): a rubber band 53992 round two rims 56145, the rims a fixed 9.6 cm apart. */
  rubber: {
    part: L.rubberTrack.part,
    rimPart: L.rims[1]!.part,
    d: L.rubberTrack.diameter! / 10,
    w: L.rubberTrack.width / 10,
    rim: L.rims[1]!.diameter! / 10,
    rimW: L.rims[1]!.width / 10,
    thick: L.rubberTrack.specs.rubber_thickness_mm! / 10,
    ridges: L.rubberTrack.specs.ridges!,
    rimsApart: L.rubberTrackRims_ldu * LDU,
  },
  /** The Education set's (45544): wide links 88323 round ten-tooth sprockets 57519. */
  links: {
    part: L.treadLink.part,
    sprocketPart: L.sprocket.part,
    w: L.treadLink.width / 10,
    pitch: L.treadLink.specs.pitch_mm! / 10,
    /** the link's thickness, from its LDraw box */
    thick: (L.treadLink.bbox.max[1]! - L.treadLink.bbox.min[1]!) * LDU,
    sprocket: L.sprocket.diameter! / 10,
    sprocketW: L.sprocket.width / 10,
    teeth: L.sprocket.specs.teeth!,
    d: L.sprocket.specs.rolling_diameter_with_tread_mm! / 10,
  },
};
if (L.rims[1]!.part !== "56145") throw new Error("the rubber track's rim is not 56145 in the map");

/** The ball caster of the Education base: a steel ball 99948 in its receptacle 92911. */
export const CASTER = {
  ball: L.ball.diameter! / 10,
  socket: { d: L.ballSocket.diameter! / 10, w: L.ballSocket.width / 10 },
};
/** The small wheel a passive caster or skid rolls on (tyre 89201). */
export const SMALL_WHEEL = { d: L.smallWheel.diameter! / 10, w: L.smallWheel.width / 10 };

/** Not LEGO's numbers. */
export const OTHER = {
  /** the flat EV3 cable's section: the map has no number for it (estimate, cm) */
  cable: { w: 0.42, h: 0.16 },
  /** a common 6.1-inch phone, cm */
  phone: { l: 14.7, w: 7.15, h: 0.95 },
};
