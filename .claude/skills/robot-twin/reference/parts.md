# LEGO wheels and sprockets: diameters for `wheel_diameter_cm`

Offer the rows as a pick list. The map wins over this table: an official model's `wheel_diameter_mm` in `builds.json` (it is what the model rolls, a little under the tyre's outer size), else the part's `outer_diameter_mm` in `rolling.json`; a row whose part is in rolling.json repeats its number; the other rows are for parts the map does not have. `wheel_diameter` is confirmed when the person picks a row, reads the size printed on the tire wall (`56 x 28`: diameter 56 mm), or measures; a row you pick from the photo stays assumed. State 6 CALIBRATE replaces it with a measured value.

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
| Very large tire `81.8 x 50` | tire 32296 | 81.8 mm | 8.18 | [BrickLink 32296](https://www.bricklink.com/v2/catalog/catalogitem.page?P=32296) |
| Small tire `37 x 18` | tire 56891 | 37 mm | 3.7 | [BrickLink 56891](https://www.bricklink.com/v2/catalog/catalogitem.page?P=56891) |
| Thin motorcycle wheel | wheel 2903 | 61.6 mm | 6.16 | [BrickLink 2903](https://www.bricklink.com/v2/catalog/catalogitem.page?P=2903) |
| Large wheel `68.8 x 36` on rim 15038: the Education expansion set (45560) | tyre 44771 on rim 15038 | 68.8 mm | 6.88 | the map's `rolling.json` (`tyre_69x36`) |
| One black rubber track band with ridges, on two small rims a side: the EV3 retail set (31313), TRACK3R, EV3RSTORM, GRIPP3R | track 53992 on rims 56145 | 36.8 mm over the track | 3.68; calibrate | the map's `rolling.json` (`track_rubber`) |
| Black plastic tread links clicked into a track over 10-tooth sprockets (5 × 5 studs): the Education sets (45544, 45560), Tank Bot | links 88323 on sprocket 57519 | about 54-55 mm rolling | 5.4; calibrate | the map's `rolling.json` (`tread_link`, `sprocket_10t`); Tank Bot in `builds.json` |
| Any other tracks | | | the sprocket's or rim's diameter plus the track, measured; else 4.0; calibrate | |

Look-alikes. Tell 56 mm from 43.2 mm by the size against the brick: a 56 mm wheel is about half the brick's length (11.1 cm), a 43.2 mm one well under half, and the 43.2 mm tire hides its small rim almost fully. Tell 49.5 from 56 by width: `49.5 x 20` is visibly thinner than `56 x 28`. A rim with six round pin holes is 56908; a solid reinforced rim is 56145.

Tracks: the diameter over the rims or sprocket teeth is not the distance a track moves per turn. A tracked base also turns with slip, so its `axle_track_cm` after calibration is larger than the distance between the tracks. That is expected. Always do state 6.

## Distance between the wheels: `axle_track_cm`

From the middle of the left tire's tread to the middle of the right tire's tread, in cm (tracks: track middle to track middle). State 6 corrects it.

## A caster, a skid, or passive wheels

Whatever touches the floor with no motor turning it is a support: a steel ball in a socket (the Education caster), a swivel wheel, a skid, or small wheels on a free axle. Write `view.caster` as the closest: `"ball"` (a steel ball or a swivel wheel), `"wheel"` (small passive wheels), `"skid"`, with `back_cm` (or `front_cm`) reaching it, and a note when it is not that part ("a swivel caster, drawn as a ball"). Wheels that a chain, gears or a second motor turn are driven, not passive: robot-file.md "What a twin cannot have", four or six wheels.
