// The scripted routes of the terrain worlds of deployments/orugas: waypoints (x, y) from each world's start to its
// point `meta`. terrain-worlds.test.ts drives them through the tools on several seeds; worlds.test.ts relies on them
// for the reachability its flat search cannot prove on terrain (an edge, a slope, a bridge narrower than a spin).
/** The scripted route of each world: waypoints (x, y) on the way to its point `meta`. */
export const ROUTES: Record<string, [number, number][]> = {
  rampa: [
    [120, 60],
    [217, 60],
  ],
  puente: [
    [112, 60],
    [150, 60],
    [205, 60],
    [285, 60],
  ],
  escalones: [
    [90, 117],
    [125, 117],
    [160, 117],
    [182, 50],
  ],
  colina: [
    [128, 92],
    [115, 108],
  ],
  circuito: [
    [112, 47],
    [112, 155],
  ],
};
