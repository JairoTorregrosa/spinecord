// Every real dimension the 3D robot is drawn with, in cm, in one table, each with the part it is and where the
// number comes from, so a sourced parts map can replace this file in one edit. "estimate" marks a size that was
// read off photos because no source gave it. The shapes in the part files are proportioned from these.
//
// The LEGO module: 8 mm between studs and between Technic holes (20 LDU of 0.4 mm), a plate 3.2 mm high.

export interface Dim {
  /** LEGO / BrickLink design number of the part, when it is a LEGO part. */
  part: string | null;
  /** Length along its main axis, width across, height; cm. */
  l: number;
  w: number;
  h: number;
  source: string;
}

export const MODULE = 0.8; // LDraw: a straight beam or axle of n holes is n × 20 LDU (forums.ldraw.org/post-22739)
export const PLATE = 0.32;

export const DIMS = {
  brick: {
    part: "95646",
    l: 11.94,
    w: 7.62,
    h: 4.83,
    source: "EV3 Intelligent Brick 45500, 11.94 × 7.62 × 4.83 cm (retail listings, desertcart 732846579)",
  },
  largeMotor: {
    part: "95658",
    l: 11.6,
    w: 2.4,
    h: 4.2,
    source: "EV3 Large Servo Motor 45502, 12 × 4 × 5 cm with its hub, rounded (brickshop.eu); profile an estimate",
  },
  mediumMotor: {
    part: "99455",
    l: 7.1,
    w: 2.3,
    h: 3.0,
    source: "EV3 Medium Motor 99455, 2.8 × 0.9 × 1.2 in (Brick Owl catalog 269807)",
  },
  colorSensor: {
    part: "95650",
    l: 3.8,
    w: 2.3,
    h: 3.0,
    source: "EV3 Colour Sensor 95650, 1.5 × 0.9 × 1.2 in (Brick Owl catalog 470546)",
  },
  ultrasonicSensor: { part: "95652", l: 2.7, w: 4.8, h: 2.8, source: "estimate (no source found)" },
  infraredSensor: { part: "95654", l: 2.7, w: 4.8, h: 2.8, source: "estimate (no source found)" },
  touchSensor: { part: "95648", l: 3.9, w: 1.9, h: 2.4, source: "estimate (no source found)" },
  gyroSensor: { part: "99380", l: 1.85, w: 2.4, h: 2.4, source: "estimate (no source found)" },
  treadLink: {
    part: "57518",
    l: 1.87,
    w: 3.84,
    h: 0.84,
    source: "Technic Link Tread Wide with 2 Pin Holes, 3.84 × 0.84 × 1.87 cm (BrickLink 57518)",
  },
  sprocket: {
    part: "57519",
    l: 4.04,
    w: 4.04,
    h: 2.3,
    source:
      "Technic Tread Sprocket Wheel Large, 10 teeth, Ø 40.4-40.7 mm (Brick Owl / BrickLink 57519); width estimate",
  },
  beam: {
    part: "liftarm 1 × n thick (32524 is 1 × 7)",
    l: MODULE,
    w: 0.72,
    h: 0.72,
    source: "pitch 8 mm (LDraw); 7.2 mm thick and holes Ø 4.8 mm are the usual Technic figures, unsourced here",
  },
  stud: { part: null, l: 0.48, w: 0.48, h: 0.17, source: "Ø 4.8 mm × 1.7 mm, the usual LEGO figures, unsourced here" },
  cable: { part: "EV3 cable", l: 0, w: 0.42, h: 0.16, source: "estimate (no source found)" },
  phone: { part: null, l: 14.7, w: 7.15, h: 0.95, source: "a common 6.1-inch phone" },
} satisfies Record<string, Dim>;

/** The wheels a drive can have: the tyre's outer diameter and width, the rim's diameter. */
export const WHEELS: (Dim & { rim: number })[] = [
  {
    part: "41897 on 56908",
    l: 5.6,
    w: 2.8,
    h: 5.6,
    rim: 4.32,
    source: "Tire 56 × 28 ZR Street on Wheel 43.2 × 26 Technic Racing Small, 6 pin holes (BrickLink 41897, 56908)",
  },
  {
    part: "44309 on 56904",
    l: 4.32,
    w: 2.2,
    h: 4.32,
    rim: 3.0,
    source: "Tire 43.2 × 22 ZR on Wheel 30 × 20 (names; part numbers and rim size unverified)",
  },
  {
    part: "2903 on 2902",
    l: 8.16,
    w: 1.5,
    h: 8.16,
    rim: 6.0,
    source: "Tire 81.6 × 15 Motorcycle (name gives the size; part numbers and rim size unverified)",
  },
];

/** The real wheel whose tyre is nearest the profile's wheel diameter. */
export const wheelFor = (diameterCm: number) =>
  WHEELS.reduce((best, w) => (Math.abs(w.l - diameterCm) < Math.abs(best.l - diameterCm) ? w : best));
