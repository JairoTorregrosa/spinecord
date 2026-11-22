# deployments/example

A deployment is data only: robot files, and worlds of its own when it has them. Copy this folder, fill it in, give its files to the server (`bun apps/local/main.ts --help`). Packages never import from `deployments/`.

| File | What |
|---|---|
| `robots/r1.json` | The robot `r1`: LEGO EV3 educator base (motor pair B+C, wheel 5.6 cm, axle 12 cm, `forward_sign` 1). `pair` and `hardware` configure the EV3 provider (`hardware.speech_volume_pct`, 1..100, is the loudness of `speak` on ev3dev and is required there), `profile` is the contract's RobotProfile. `profile.drivetrain.forward_sign` is `1` when positive motor degrees drive the robot forward and `-1` when they drive it backward: check it on the real robot with a 5 cm `drive`. The same file serves the hardware robot (`--ev3`, `--ev3dev`) and its twin `r1-sim` (`--twin`); without arguments the server runs that twin, and each of those flags without a file uses this file. One shape and one validator: `parseRobotFile` in `packages/driver-ev3/robot-file.ts`. |

Worlds for a twin ship with the packages: `apps/local/examples/room.json`, `packages/sim-world/examples/`.
