# LEGO wheels and sprockets: diameters for `wheel_diameter_cm`

Offer the rows as a pick list. `wheel_diameter` is confirmed when the person picks a row, reads the size printed on the tire wall (`56 x 28`: diameter 56 mm), or measures; a row you pick from the photo stays assumed. State 6 CALIBRATE replaces it with a measured value.

| What you see | Part | Outer diameter | `wheel_diameter_cm` | Source |
|---|---|---|---|---|
| Wide black tire on a grey rim with six pin holes: the EV3 education core set (45544) | tire 41897 `56 x 28 ZR` on rim 56908 | 56 mm | 5.6 | [ev3dev2 `wheel.py`](https://github.com/ev3dev/ev3dev-lang-python/blob/ev3dev-stretch/ev3dev2/wheel.py); [BrickLink 41897](https://www.bricklink.com/v2/catalog/catalogitem.page?P=41897) |
| Rounded "balloon" tire, about as wide as the education tire | tire 55976 `56 x 26 Balloon` | 56 mm | 5.6 | [BrickLink 55976](https://www.bricklink.com/v2/catalog/catalogitem.page?P=55976) |
| Black tire on a small grey rim with no pin holes: the EV3 retail set (31313) | tire 44309 `43.2 x 22 ZR` on rim 56145 | 43.2 mm | 4.32 | [ev3dev2 `wheel.py`](https://github.com/ev3dev/ev3dev-lang-python/blob/ev3dev-stretch/ev3dev2/wheel.py); [BrickLink 44309](https://www.bricklink.com/v2/catalog/catalogitem.page?P=44309) |
| The small rim 56145 with no tire | rim 56145 | 30.4 mm | 3.04 | [BrickLink 56145](https://www.bricklink.com/v2/catalog/catalogitem.page?P=56145) |
| The education rim 56908 with no tire | rim 56908 | 43.2 mm | 4.32 | [BrickLink 56908](https://www.bricklink.com/v2/catalog/catalogitem.page?P=56908) |
| Thin tire `49.5 x 20` | tire 15413 | 49.5 mm | 4.95 | [BrickLink 15413](https://www.bricklink.com/v2/catalog/catalogitem.page?P=15413) |
| Tire `49.6 x 28 VR` | tire 6594 | 49.6 mm | 4.96 | [BrickLink 6594](https://www.bricklink.com/v2/catalog/catalogitem.page?P=6594) |
| Thin tall tire `62.4 x 20` | tire 32019 | 62.4 mm | 6.24 | [BrickLink 32019](https://www.bricklink.com/v2/catalog/catalogitem.page?P=32019) |
| Large low tire `68.8 x 36` | tire 44771 | 68.8 mm | 6.88 | [BrickLink 44771](https://www.bricklink.com/v2/catalog/catalogitem.page?P=44771) |
| Very large tire `81.8 x 50` | tire 32296 | 81.8 mm | 8.18 | [BrickLink 32296](https://www.bricklink.com/v2/catalog/catalogitem.page?P=32296) |
| Small tire `37 x 18` | tire 56891 | 37 mm | 3.7 | [BrickLink 56891](https://www.bricklink.com/v2/catalog/catalogitem.page?P=56891) |
| Thin motorcycle wheel | wheel 2903 | 61.6 mm | 6.16 | [BrickLink 2903](https://www.bricklink.com/v2/catalog/catalogitem.page?P=2903) |
| Tracks on the large 10-tooth sprocket (5 × 5 studs; the retail set's tracked builds), wide tread links with 2 pin holes | sprocket 57519, links 57518 | 40.4 to 40.7 mm over the teeth | 4.0; calibrate | [BrickLink 57519](https://www.bricklink.com/v2/catalog/catalogitem.page?P=57519); [Brick Owl 57519](https://brickowl.com/ca/catalog/lego-technic-sprocket-wheel-40-4-57519) |
| Any other tracks, or tread links with rubber pads | | | the sprocket's diameter over the teeth, measured; else 4.0; calibrate | |

Look-alikes. Tell 56 mm from 43.2 mm by the size against the brick: a 56 mm wheel is about half the brick's length (11.5 cm), a 43.2 mm one well under half, and the 43.2 mm tire hides its small rim almost fully. Tell 49.5 from 56 by width: `49.5 x 20` is visibly thinner than `56 x 28`. A rim with six round pin holes is 56908; a solid reinforced rim is 56145.

Tracks: the diameter over the sprocket teeth is not the distance a track moves per turn. A tracked base also turns with slip, so its `axle_track_cm` after calibration is larger than the distance between the tracks. That is expected. Always do state 6.

## Distance between the wheels: `axle_track_cm`

From the middle of the left tire's tread to the middle of the right tire's tread, in cm (tracks: track middle to track middle). State 6 corrects it.
