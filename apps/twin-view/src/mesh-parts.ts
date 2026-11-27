// The parts the page draws from their real LDraw mesh (meshes.ts); every other part stays procedural: beams,
// axles, wheels and tracks are exact from the parts map's numbers at a few hundred triangles each, where their
// meshes cost thousands for detail nobody reads at robot scale. scripts/ldraw-meshes.ts converts these.
export const REAL = new Set(["95646", "95646c01", "95658", "99455", "95648", "95650", "99380", "95652", "95654"]);
