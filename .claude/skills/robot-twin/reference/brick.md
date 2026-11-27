# From `describe_robot` of the brick to `twin.ev3`

`describe_robot` on a connected EV3 lists one device per port that has something plugged in. A port with nothing has no device.
Read each device's `kind` and `description`:

| Device | `kind` | `description` starts with | `twin.ev3` |
|---|---|---|---|
| `ev3.A`..`ev3.D` | `motor` | `EV3 large motor on output port X` | `"motors": {"X": "large"}` |
| `ev3.A`..`ev3.D` | `motor` | `EV3 medium motor on output port X` | `"motors": {"X": "medium"}` |
| `ev3.S<n>` | `touch` | `EV3 touch sensor` or `NXT touch sensor` | `"sensors": {"<n>": "touch"}` |
| `ev3.S<n>` | `color` | `EV3 color sensor` | `"sensors": {"<n>": "color"}` |
| `ev3.S<n>` | `ultrasonic` | `EV3 ultrasonic` or `NXT ultrasonic` | `"sensors": {"<n>": "ultrasonic"}` |
| `ev3.S<n>` | `gyro` | `EV3 gyro sensor` | `"sensors": {"<n>": "gyro"}` |
| `ev3.S<n>` | `infrared` | `EV3 infrared sensor` | `"sensors": {"<n>": "ir"}` |
| `ev3.S<n>` | `light`, `sound`, `temperature`, `sensor` | anything else | nothing: the twin has no such sensor. Give the port no role |

`ev3.pair` is the pair the robot file used to connect, not what the robot has. Ignore it, and ignore the `roles` of the devices: they come from that file too.
The brick confirms all eight ports, the empty ones too: take `A`-`D` and `S1`-`S4` out of `twin.unconfirmed` (keep a port whose motor's job you do not know yet).
The brick does not say which motor drives which side, what an actuator does, or where anything sits: ask the person (state 1).
