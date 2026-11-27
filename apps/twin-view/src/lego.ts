// The numbers of the LEGO parts map (packages/lego-parts) the 3D view draws with, read when the page is built. It
// is imported as a Bun macro (`import { legoMap } from "./lego" with { type: "macro" }`): Bun runs it while it
// bundles the page (and when bun runs a test), and only the object it returns goes into the page, not the map's
// 400 KB of data and sources. Every number keeps the unit and frame of the map: LDU in the part's LDraw frame,
// mm for diameters and widths.
import { geometryOf, isUnknown, loadLegoParts, type Maybe } from "../../../packages/lego-parts/index.ts";

const value = (m: Maybe<number | string> | undefined, what: string): number => {
  if (!m || isUnknown(m)) throw new Error(`the LEGO parts map has no ${what}`);
  const v = Number(m.value);
  if (!Number.isFinite(v)) throw new Error(`the LEGO parts map's ${what} is not a number: ${m.value}`);
  return v;
};

export function legoMap() {
  const map = loadLegoParts();
  const unit = (k: string) => value(map.units[k] as Maybe, `units.${k}`);
  const elec = (key: string) => {
    const p = map.electronics.find((e) => e.key === key);
    if (!p) throw new Error(`the LEGO parts map has no electronic part ${key}`);
    if (!p.ids.ldraw) throw new Error(`${key} has no LDraw file`);
    const g = geometryOf(map, p.ids.ldraw);
    return {
      ldraw: p.ids.ldraw,
      bbox: g.bbox_ldu,
      /** Technic holes on the half-module grid: centre (LDU) and axis */
      holes: g.holes.map((h) => ({ kind: h.kind, at: h.center_ldu, axis: h.axis })),
      features: Object.fromEntries(
        Object.entries(p.features).map(([k, f]) => [k, { at: f.position_ldu, dir: f.direction ?? null }]),
      ),
      specs: Object.fromEntries(
        Object.entries(p.specs ?? {}).flatMap(([k, s]) =>
          !isUnknown(s) && typeof s.value === "number" ? [[k, s.value]] : [],
        ),
      ),
    };
  };
  const roll = (key: string) => {
    const p = map.rolling.find((r) => r.key === key);
    if (!p) throw new Error(`the LEGO parts map has no rolling part ${key}`);
    return {
      part: p.ids.design,
      /** null for a part that has none (a tread link) */
      diameter: isUnknown(p.outer_diameter_mm) ? null : value(p.outer_diameter_mm, `${key}.outer_diameter_mm`),
      width: value(p.width_mm, `${key}.width_mm`),
      fits: p.fits ?? [],
      specs: Object.fromEntries(
        Object.entries(p.specs ?? {}).flatMap(([k, s]) =>
          !isUnknown(s) && typeof s.value === "number" ? [[k, s.value]] : [],
        ),
      ),
    };
  };
  const link = map.rolling.find((r) => r.key === "tread_link");
  const beam = geometryOf(map, "32524");
  // TRACK3R's rims (56145) on one side, from Philo's model: their spread along the robot is how far apart a
  // rubber track's two rims sit (it is one fixed length of rubber)
  const placed = JSON.stringify(map.models).match(/\{[^{}]*"part":"56145"[^{}]*\}/g) ?? [];
  const rimX = placed.map((p) => (JSON.parse(p) as { position_ldu: number[] }).position_ldu[0]!);
  if (rimX.length < 2) throw new Error("the LEGO parts map's TRACK3R model has no rims 56145");
  return {
    ldu_mm: unit("ldu_mm"),
    module_mm: unit("module_mm"),
    plate_mm: unit("plate_height_mm"),
    brick_mm: unit("brick_height_mm"),
    stud_d_mm: unit("stud_diameter_mm"),
    stud_h_mm: unit("stud_height_mm"),
    pin_hole_mm: unit("pin_hole_diameter_mm"),
    axle_cross_mm: unit("axle_cross_mm"),
    beam_mm: unit("beam_thick_mm"),
    /** a thick beam's size across its holes' axis, from beam 7's LDraw box */
    beam_across_ldu: beam.size_ldu[0],
    brick: elec("brick"),
    brickRechargeable: elec("brick_rechargeable"),
    largeMotor: elec("large_motor"),
    mediumMotor: elec("medium_motor"),
    touch: elec("touch_sensor"),
    color: elec("color_sensor"),
    ultrasonic: elec("ultrasonic_sensor"),
    gyro: elec("gyro_sensor"),
    infrared: elec("infrared_sensor"),
    tyres: ["tyre_56x28", "tyre_43x22", "tyre_69x36"].map(roll),
    rims: ["rim_43x26", "rim_30x20", "rim_56x34"].map(roll),
    rubberTrack: roll("track_rubber"),
    sprocket: roll("sprocket_10t"),
    treadLink: { ...roll("tread_link"), bbox: geometryOf(map, link?.ids.ldraw ?? "88323").bbox_ldu },
    ball: roll("steel_ball"),
    ballSocket: roll("ball_socket"),
    smallWheel: roll("tyre_24x14"),
    /** TRACK3R: how far apart one track's two rims are, LDU (the rubber track is one fixed length) */
    rubberTrackRims_ldu: Math.max(...rimX) - Math.min(...rimX),
  };
}
