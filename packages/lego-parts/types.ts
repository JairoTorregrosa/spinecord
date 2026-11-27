// The shapes of the data files in data/. Every number a person or a model relies on is a Fact (a value with the
// URL it comes from) or an Unknown (why it could not be sourced). Geometry read from LDraw lives in
// data/ldraw-geometry.json, written by tools/extract-ldraw.ts; the curated files point into it by LDraw id.

/** A sourced value. `alt` holds what other sources say when they disagree; `note` says which one was taken and why. */
export type Fact<T = number> = {
  value: T;
  unit?: string;
  source: string;
  note?: string;
  alt?: { value: T; source: string; note?: string }[];
};
export type Unknown = { unknown: true; reason: string };
export type Maybe<T = number> = Fact<T> | Unknown;

export const isUnknown = <T>(m: Maybe<T>): m is Unknown => (m as Unknown).unknown === true;

/** LDraw coordinates: LDU, -Y up, a part's own origin. 1 LDU = 0.4 mm, 20 LDU = 1 module (stud pitch, 8 mm). */
export type Vec3 = [number, number, number];

export type Ids = {
  /** LEGO design number (the number moulded on the part, the BrickLink/Rebrickable part number in most cases) */
  design: string;
  /** LEGO product number when the part was sold on its own (45500…45509) */
  product?: string;
  /** LEGO element ids (design + colour), from Rebrickable's elements.csv */
  elements?: string[];
  bricklink: string;
  rebrickable: string;
  /** null when LDraw has no file for the part */
  ldraw: string | null;
  source: string;
  note?: string;
};

// ---------- generated: data/ldraw-geometry.json ----------

export type Hole = {
  kind: "pin" | "axle";
  /** unit vector of the hole's axis, sign chosen so its largest component is positive */
  axis: Vec3;
  center_ldu: Vec3;
  center_modules: Vec3;
  /** distance between the first and last hole primitive along the axis; 0 = one face ring only (a blind or partial hole) */
  depth_ldu: number;
};
export type SubPart = { ldraw: string; title: string; position_ldu: Vec3; rotation: number[] };
export type PartGeometry = {
  ldraw: string;
  title: string;
  source: string;
  license: string;
  bbox_ldu: { min: Vec3; max: Vec3 };
  size_ldu: Vec3;
  size_mm: Vec3;
  size_modules: Vec3;
  triangles: number;
  /** holes whose centre lies on the half-module grid (10 LDU) */
  holes: Hole[];
  /** hole primitives off the half-module grid, kept apart rather than published as connection points */
  off_grid_holes: Hole[];
  subparts: SubPart[];
};
export type GeometryFile = {
  note: string;
  library: string;
  library_source: string;
  parts: Record<string, PartGeometry>;
};

// ---------- curated ----------

/** A named point on a part: a cable socket, a port, the output hub, the sensing element. */
export type Feature = {
  /** position in the part's LDraw frame */
  position_ldu: Vec3;
  /** the way it faces or turns about, in the part's LDraw frame */
  direction?: Vec3;
  /** the LDraw sub-part the position is read from, when there is one */
  ldraw_subpart?: string;
  source: string;
  note?: string;
};

export type ElectronicPart = {
  key: string;
  name: string;
  kind: "brick" | "motor" | "sensor" | "beacon" | "battery" | "cable";
  ids: Ids;
  mass_g: Maybe;
  colour: string;
  /** how to tell it apart in a photo */
  recognise: string;
  features: Record<string, Feature>;
  specs?: Record<string, Maybe<number | string>>;
  /** for cables */
  length_cm?: Maybe;
};

export type RollingPart = {
  key: string;
  name: string;
  kind: "rim" | "tyre" | "wheel" | "tread" | "tread_link" | "sprocket" | "caster";
  ids: Ids;
  outer_diameter_mm: Maybe;
  width_mm: Maybe;
  mass_g: Maybe;
  recognise: string;
  /** tyre ↔ rim pairings, by key */
  fits?: string[];
  specs?: Record<string, Maybe<number | string>>;
};

export type StructuralPart = {
  key: string;
  name: string;
  kind: "beam" | "bent_beam" | "frame" | "thin_beam" | "axle" | "pin" | "connector";
  ids: Ids;
  /** length in modules (holes for beams, units for axles and pins) */
  length_modules: Maybe;
  recognise?: string;
};

export type SetLine = { part: string; colour_id: number; colour: string; quantity: number; spare: boolean };
export type LegoSet = {
  set: string;
  name: string;
  year: number;
  source: string;
  inventory_source: string;
  inventory_version: number;
  lines: SetLine[];
};

export type Placement = {
  part: string;
  /** in the build's frame (see Build.frame) */
  position_ldu?: Vec3;
  port?: string;
  source: string;
  note?: string;
};
export type Build = {
  key: string;
  name: string;
  set: string;
  instructions: Maybe<string>;
  frame: string;
  wheel_diameter_mm: Maybe;
  axle_track_mm: Maybe;
  footprint_mm: Maybe<[number, number, number]>;
  ports: Record<string, Maybe<string>>;
  placements: Placement[] | Unknown;
  ldraw_model: Maybe<string>;
  note?: string;
};
