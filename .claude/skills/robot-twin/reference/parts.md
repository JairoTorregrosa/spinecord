# LEGO wheels and sprockets: diameters for `wheel_diameter_cm`

Offer the rows as a pick list. The person picks the one that matches the robot, or reads the size printed on the tire wall (for example `56 x 28`: diameter 56 mm, width 28 mm).
The value is a starting point. State 6 CALIBRATE replaces it with a measured one.

| What the person sees | Part | Outer diameter | `wheel_diameter_cm` | Source |
|---|---|---|---|---|
| Wide black tire on a grey rim, the EV3 Education core set (45544) | tire 41897 on rim 56908 | 56 mm | 5.6 | [ev3dev2 `wheel.py`, `EV3EducationSetTire`](https://github.com/ev3dev/ev3dev-lang-python/blob/ev3dev-stretch/ev3dev2/wheel.py); [BrickLink 41897](https://www.bricklink.com/v2/catalog/catalogitem.page?P=41897) |
| Black tire on a small grey rim, the EV3 retail set (31313) | tire 44309 on rim 56145 | 43.2 mm | 4.32 | [ev3dev2 `wheel.py`, `EV3Tire`](https://github.com/ev3dev/ev3dev-lang-python/blob/ev3dev-stretch/ev3dev2/wheel.py); [BrickLink 44309](https://store.bricklink.com/v2/catalog/catalogitem.page?P=44309) |
| The same small rim with no tire | rim 56145 | 30 mm | 3.0 | [ev3dev2 `wheel.py`, `EV3Rim`](https://github.com/ev3dev/ev3dev-lang-python/blob/ev3dev-stretch/ev3dev2/wheel.py) |
| The education rim with no tire | rim 56908 | 43 mm | 4.3 | [ev3dev2 `wheel.py`, `EV3EducationSetRim`](https://github.com/ev3dev/ev3dev-lang-python/blob/ev3dev-stretch/ev3dev2/wheel.py) |
| Thin tire `49.5 x 20` | tire 15413 | 49.5 mm | 4.95 | [BrickLink 15413](https://www.bricklink.com/catalogItem.asp?P=15413) |
| Large low tire `68.8 x 36` | tire 44771 | 68.8 mm | 6.88 | [BrickLink 44771](https://www.bricklink.com/v2/catalog/catalogitem.page?P=44771); [Brick Architect 44771](https://brickarchitect.com/parts/44771) |
| Tracks on the large 10-tooth sprocket (the retail set's tracked builds) | sprocket 57519, tread links 57518 | 40.4 to 40.7 mm over the teeth | 4.0 to start; calibrate | [Brick Owl 57519](https://brickowl.com/ca/catalog/lego-technic-sprocket-wheel-40-4-57519); [Brick Architect 57519](https://brickarchitect.com/parts/57519) |

Checked 2026-11-27.

Tracks: the diameter over the sprocket teeth is not the distance a track moves per turn. Write 4.0 and always do state 6 CALIBRATE.
A tracked base also turns with slip, so its `axle_track_cm` after calibration is larger than the distance between the tracks. That is expected.

When no row matches, ask the person to measure the wheel across its middle with a ruler, in centimetres, to the millimetre.

## Distance between the wheels: `axle_track_cm`

Ask the person to measure from the middle of the left tire's tread to the middle of the right tire's tread, in centimetres.
For tracks, measure from the middle of the left track to the middle of the right track.
State 6 CALIBRATE corrects this number too.
