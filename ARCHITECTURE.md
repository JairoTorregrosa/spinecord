# Architecture: packages and their boundaries

## Name

**spinecord**: the spinal cord between a brain (the model) and a body (the robot). The model decides; the runtime runs fast reflexes next to the hardware. Package scope `@spinecord/*`.

## Dependency direction

```
protocol ← driver-ev3 ← sim-ev3 → sim-world → protocol
protocol ← driver-ev3dev
protocol ← runtime        (talks to drivers only through the Provider interface)
protocol ← page-hub
protocol, runtime, driver-ev3, driver-ev3dev, sim-ev3, sim-world, page-hub ← apps/local   (it also builds and serves apps/robot-page's bridge page and apps/peripheral-page)
driver-ev3 ← apps/robot-page
protocol ← apps/peripheral-page   (types; its tests also use protocol's validators)
```

`protocol` imports nothing. Apps import packages; no package imports an app. `scripts/check-boundaries.ts` enforces this graph.

## Responsibilities

| Package | Owns | Never does |
|---|---|---|
| `protocol` | Types, FSM transition tables, the MCP tool catalog (`TOOLS`, with input and output schemas and the server instructions), and pure dependency-free validators shared by everyone (`validate.ts`: programs, conditions, loops; `schema.ts`: the one JSON Schema validator), and the law of a loop (`loop.ts`: planning and one tick, pure; `loop-golden.json`: the vectors every implementation of the law passes). | I/O, state, defaults for a specific robot. |
| `driver-ev3` | EV3 direct-command encoding/decoding, transports (WebHID, any byte Transport), serial link, `Ev3Provider` (EV3 ports → DeviceSpecs, bounded commands, verified stop, a loop's tick as one direct command), the robot file parser. | Kinematics, conditions, programs, MCP, robot state. |
| `driver-ev3dev` | ev3dev bridge (Python 3.5, stdlib) over SSH stdio, on-brick watchdog, `Ev3devProvider` with the same device ids as `driver-ev3`. | Anything `driver-ev3` does not expose to a model. |
| `sim-world` | World model loaded from JSON, physics, sensor models, `SimWorldProvider` (`sim.world`, `sim.camera`, `sim.speaker`), declarative training, viewer pieces. | Hardware protocols; hardcoded worlds or tasks. |
| `sim-ev3` | `SimBrick`: byte-level EV3 firmware emulator implementing the `driver-ev3` Transport on top of `sim-world`; demo page. | Tool semantics: the twin runs the real `Ev3Provider`. |
| `runtime` | Executes the tools that address one robot, next to the hardware: device registry, role resolution, reads, sampling, conditions, kinematics for any `motor_pair` drivetrain the profile declares (heading from the channel the profile names, else from the wheel encoders), arg validation and clamping, chunking, program interpreter, the host executor of a loop (its ticks, duration, overrun rule and report). | MCP, link and activity state, anything EV3-specific. |
| `page-hub` | `PageHub`, a `Provider`: the peripheral pages of one robot (CONTRACT §2.4), their manifests, the pushed-value cache, requests with deadlines, frames and their limits, `stop`. It talks to a page through a `PageSocket`, so a test hands it a fake. | Listening on a port, tokens, the page state machine and its ping timers (they are `apps/local`'s). |
| `apps/local` | The server (CONTRACT §6): MCP over stdio with the runtime and the robots (twin, ev3dev over SSH, stock EV3 behind the bridge page, a robot with no body whose devices pages lend) in one bun process. With pages on: the page listener on loopback (and, with `--lan`, the TLS listener on one private interface with its certificate; with `--page-origin`, the listener a tunnel forwards to), the pairing token and its link as a QR code, the limit on wrong tokens, the Host and Origin checks, the page state machine. Serves the catalog verbatim, validates inputs and results, owns the link and activity state of its robots (the `looping` activity included), the backstop behind every call and behind a loop, a loop's attention window, and the stop at exit. | Device semantics, kinematics, condition evaluation, robot-specific limits (they come from the profile). |
| `apps/robot-page` | The bridge page a person opens in Chrome or Edge to lend a stock EV3 over USB: WebHID reports ⇄ one WebSocket on `127.0.0.1`, and a brake of every motor when that socket closes. | Running a runtime, timers on the path of a command. |
| `apps/peripheral-page` | The page a person opens to lend a robot the devices of a computer or phone (CONTRACT §2.4): the kit (`src/kit.ts`: socket, hello, pongs, the device registry, pushes, pause and stop lending), the shipped kinds (`src/devices/`: camera, microphone, speaker, display, touch_panel), feature detection and the one tap (`src/browser.ts`), the banner, and `window.spinecord`, the extension API. | Anything of a runtime or the hub; storing what it captures; a timer on the path of a ping, a read or a command. |
| `deployments/<name>/` | Robot files (profile, hardware, and `pair` for a robot with a synchronized motor pair) and worlds. | Code. |

## Rules

- A new device kind = a manifest. A new robot = a profile. A new use = a deployment folder. None of them changes a package.
- Limits and thresholds come from the profile; packages ship no use-specific defaults beyond a documented example profile for each provider.
- Each FSM has exactly one owner (`apps/local`: link, activity and life of the robots in its process, and each page's state; runtime: execution of one call; `apps/robot-page`: the page's device and socket; `apps/peripheral-page`: its kit's lending state). Others read state, never write it.
- Errors cross boundaries only as contract `ErrorCode`s.
