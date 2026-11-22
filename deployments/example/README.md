# deployments/example

A deployment is data only: robot files, and worlds of its own when it has them. Copy this folder, fill it in, give its files to the server (`bun apps/local/main.ts --help`). Packages never import from `deployments/`.

| File | What |
|---|---|
| `robots/r1.json` | The robot `r1`: LEGO EV3 educator base (motor pair B+C, wheel 5.6 cm, axle 12 cm, `forward_sign` 1). `pair` and `hardware` configure the EV3 provider, `profile` is the contract's RobotProfile. The same file serves the hardware robot (`--ev3`, `--ev3dev`) and its twin `r1-sim` (`--twin`); without arguments the server runs that twin. One shape and one validator: `parseRobotFile` in `packages/driver-ev3/robot-file.ts`. |

Worlds for a twin ship with the packages: `apps/local/examples/room.json`, `packages/sim-world/examples/`.
