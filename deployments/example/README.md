# deployments/example

A deployment is data only: principals, robot profiles, worlds, device manifests. Copy this folder, fill it in, point the apps at it. Packages never import from `deployments/`.

| File | What |
|---|---|
| `robots/r1.json` | The robot `r1`: LEGO EV3 educator base (motor pair B+C, wheel 5.6 cm, axle 12 cm, `forward_sign` 1). `pair` and `hardware` configure the EV3 provider, `profile` is the contract's RobotProfile. Its twin `r1-sim` is built from the same file by `apps/twin-runner`. |
| `principals.json` | The `PRINCIPALS` secret for local development: the same two principals as `packages/server/.dev.vars.example` (token hashes only; the local tokens are in `packages/server/scripts/dev.md`). Never reuse them outside your machine. |
| `world.pointer.json` | Which world the twin lives in: a path to a world file that ships with `sim-world`. |

`bun run e2e` (repo root) runs this deployment end to end on your machine.
