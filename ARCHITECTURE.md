# Architecture: packages and their boundaries

## Name

**spinecord**: the spinal cord between a brain (the model) and a body (the robot). The model decides; the runtime runs fast reflexes next to the hardware. Package scope `@spinecord/*`.

## Dependency direction

```
protocol ← driver-ev3 ← sim-ev3 → sim-world → protocol
protocol ← driver-ev3dev
protocol ← runtime        (talks to drivers only through the Provider interface)
protocol ← server         (never imports runtime, drivers or sims)
runtime, server ← e2e     (tests only; nothing imports it)
protocol, runtime, driver-ev3, driver-ev3dev, sim-ev3, sim-world ← apps/local   (never server; it also builds and serves apps/robot-page's bridge page)
```

`protocol` imports nothing. Apps import packages; no package imports an app. `scripts/check-boundaries.ts` enforces this graph, including that `apps/local` never imports `packages/server`.

## Responsibilities

| Package | Owns | Never does |
|---|---|---|
| `protocol` | Types, FSM transition tables, wire protocol, MCP tool catalog (`TOOLS` for the relay, `LOCAL_TOOLS` for local mode), and pure dependency-free validators shared by everyone (`validate.ts`: programs, conditions, `profileHash`; `schema.ts`: the one JSON Schema validator, `shape` or `full`). | I/O, state, defaults for a specific robot. |
| `driver-ev3` | EV3 direct-command encoding/decoding, transports (WebHID, any byte Transport), serial link, `Ev3Provider` (EV3 ports → DeviceSpecs, bounded commands, verified stop). | Kinematics, conditions, programs, networking, knowledge of the relay. |
| `driver-ev3dev` | ev3dev bridge (Python 3.5, stdlib) over SSH stdio, on-brick watchdog, `Ev3devProvider` with the same device ids as `driver-ev3`. | Anything `driver-ev3` does not expose to a model. |
| `sim-world` | World model loaded from JSON, physics, sensor models, `SimWorldProvider` (`sim.world`, `sim.camera`, `sim.speaker`), declarative training, viewer pieces. | Hardware protocols; hardcoded worlds or tasks. |
| `sim-ev3` | `SimBrick`: byte-level EV3 firmware emulator implementing the `driver-ev3` Transport on top of `sim-world`; demo page. | Tool semantics: the twin runs the real `Ev3Provider`. |
| `runtime` | Executes robot-local tools next to the hardware: device registry, role resolution, reads, sampling, conditions, kinematics for any `motor_pair` drivetrain, arg validation and clamping, program interpreter, `RuntimeClient` (wire protocol, heartbeats, organ proxy). | Auth, persistence, multi-robot state, FSMs owned by the relay, anything EV3-specific. |
| `server` | MCP server (serves the catalog verbatim), auth by principal, per-robot FSMs (link, activity, control, call), idempotency, rate limits, dispatch to runtimes, organ routing, episodes, program library and verification orchestration, admin HTTP API, D1 storage, structured logs. | Device semantics, kinematics, condition evaluation, robot-specific limits (they come from the profile). |
| `e2e` | Tests of the seam no package can test alone: the real runtime client over a real WebSocket against the real relay (Miniflare), through MCP. | Production code; faking either side. |
| `apps/*` | Thin shells: `twin-runner` (headless twins: `SimBrick` + `Ev3Provider` + `SimWorldProvider` + runtime + client, optional viewer) and `robot-page` (the page a person opens in Chrome or Edge to lend an EV3: WebHID + runtime + client). `robot-page` also holds the bridge page of local mode (WebHID reports ⇄ one WebSocket, no runtime). `local` (CONTRACT §11): MCP over stdio with the runtime and the robots in one bun process; it owns the link and activity state of its robots and nothing else. Later: organ pages (phone camera/IMU). | Business logic; they only wire packages together with a deployment's config. |
| `deployments/<name>/` | Principals, robot profiles, worlds, organ manifests, copy for humans. | Code. |

## Rules

- A new device kind = a manifest. A new robot = a profile. A new use = a deployment folder. None of them changes a package.
- Limits and thresholds come from the profile; packages ship no use-specific defaults beyond a documented example profile for each provider.
- Each FSM has exactly one owner (relay: link, activity, control, call, episode, provider, program; runtime: execution of one call; `apps/local`: link and activity of the robots in its process). Others read state, never write it.
- Errors cross boundaries only as contract `ErrorCode`s.
