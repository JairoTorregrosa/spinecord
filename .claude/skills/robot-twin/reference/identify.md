# Reading a photo of a LEGO robot

Sizes are the parts' bounding boxes from BrickLink's catalogue (marked verified there), checked 2026-11-27. They are the ruler when the photo has none.

## What the photo shows

| It is | Tells |
|---|---|
| A photo of a built robot | Real light and shadow, a floor or table, cables that sag, parts slightly out of line, often a hand, a mat or a room |
| An instruction drawing | Flat shading, no shadow on a floor, a step number, a parts call-out box (`1x`, `2x`), an arrow showing where a part goes, white background |
| A render, box art or product photo | Perfect parts, glossy, no cables or cables drawn ideal, logo or set number; or a studio shot: a seamless backdrop curving up behind the robot, soft even light, a flawless build, no table edge, room, hand, mat or other object. Treat it like box art |
| A slide, poster or screen | A frame, text blocks, a projector's keystone, a monitor bezel, moiré, other images beside it |
| Several robots | More than one drive base or more than one brick. A robot in the background, out of focus or cut off, while one robot is the sharp subject in the middle, does not make it several: go on with the subject and say in the report which robot you used |

## Readable

The gate of state 0 counts the brick and the drive as readable only when the photo shows:
- **the brick**: its body, not only an edge or a cable, and at least one of the signs of an EV3: the screen, the dark grey button cross, a port end with its row of four sockets, or the `EV3` print. A brick covered by parts, seen only from below or from a side with none of these, or too blurred to tell any of them, is not readable. Tilted or standing upright is fine: say so in the file;
- **the drive**: what touches the floor on at least one side (wheels, tracks, legs, a fixed base), and that side's motor or the axle it drives.
A robot that hides one of the two is the "not readable" row of state 0, also when everything else is sharp.

| Brick | Tells | spinecord |
|---|---|---|
| **EV3** | Dark grey and light grey, 11.1 × 7.2 × 5.1 cm ([BrickLink 95646c01](https://www.bricklink.com/v2/catalog/catalogitem.page?P=95646c01)). A grey monochrome screen at one end of the top face; below it six buttons: a centre button inside a ring of four arrow buttons that light green, orange or red, and a back button at the screen's corner. `EV3` printed on it. **Four** output ports `A B C D` on the end beside the screen, **four** input ports `1 2 3 4` on the other end; the USB plug between them on the A-D end | yes |
| NXT | Light grey and white, an **orange** square button with two grey arrow buttons, `NXT` printed, a smaller screen. **Three** output ports `A B C` on one end, four inputs `1 2 3 4` on the other. With the brick hidden, its parts tell it: an ultrasonic with **orange rings** round its eyes, an **orange** touch plunger, motors with an **orange** hub | no: stop |
| SPIKE Prime, Robot Inventor | A square hub, no screen: a **5 × 5 grid of white lights** and one round button; **six** ports `A`-`F` along two sides. SPIKE Prime is yellow and white, Robot Inventor teal, white and black | no: stop |
| SPIKE Essential, WeDo 2.0, Powered Up | A small hub with two ports and a light, often on a yellow or light-blue base | no: stop |
| Any of the four above | **Flat white cables fixed to each motor and sensor**, round light-blue or teal motor faces, bright azure, magenta and yellow parts. EV3 cables are black and unplug at both ends | no: stop |
| RCX | A large **yellow** brick with a small screen and three plus three square stud ports | no: stop |

## Motors

| Part | Tells | Size |
|---|---|---|
| EV3 large motor (95658) | Long L-shaped housing, white and dark grey; the round end turns a **red** hub with a cross hole; the cable plugs into a socket at the square end | 11.1 × 5.9 × 4.0 cm ([BrickLink 95658](https://www.bricklink.com/v2/catalog/catalogitem.page?P=95658)) |
| EV3 medium motor (99455) | A compact block, white and grey; the **red** output on its short front face, axle along its length; many pin holes around | 7.2 × 3.1 × 2.4 cm ([BrickLink 99455](https://www.bricklink.com/v2/catalog/catalogitem.page?P=99455)) |
| NXT motor (53787) | The large motor's shape, light grey, an **orange** hub | 10.8 × 5.3 × 4.0 cm ([BrickLink 53787](https://www.bricklink.com/v2/catalog/catalogitem.page?P=53787)) |

An NXT motor on an EV3 brick works; write it as `"large"` and add a note. A motor whose cable goes nowhere visible still counts: ask which port.

## Sensors

| Part | Tells | Faces | Size |
|---|---|---|---|
| EV3 touch (95648) | Box with a **red cross-shaped plunger** on one end | where the plunger points | 6 × 3 × 3 studs, 4.4 × 3.1 × 2.4 cm ([BrickLink 95648](https://www.bricklink.com/v2/catalog/catalogitem.page?P=95648)) |
| EV3 colour (95650) | Small dark box, a round window with a lens on one face; the window glows red, blue or white when it is on | where the window points, usually down at the floor | 4.0 × 3.1 × 2.4 cm ([BrickLink 95650](https://www.bricklink.com/v2/catalog/catalogitem.page?P=95650)) |
| EV3 gyro (99380) | The colour sensor's box but **no window**; curved arrows printed on top (the axis it measures) | any; position does not matter | 4.0 × 3.1 × 2.4 cm ([BrickLink 99380](https://www.bricklink.com/v2/catalog/catalogitem.page?P=99380)) |
| EV3 ultrasonic (95652) | **Two round eyes** that stand out, side by side, with a ring around each that glows red when on | where the eyes point | 7 × 6 × 3 studs, 5.8 × 4.8 × 3.2 cm ([BrickLink 95652](https://www.bricklink.com/v2/catalog/catalogitem.page?P=95652)) |
| EV3 infrared (95654) | Same size, but a **flat, dark, glossy** front panel with two lenses behind it, nothing standing out | where the dark panel points | 5.8 × 4.8 × 3.1 cm ([BrickLink 95654](https://www.bricklink.com/v2/catalog/catalogitem.page?P=95654)) |
| NXT touch (53793) | An **orange** plunger, light grey box | | [BrickLink 53793](https://www.bricklink.com/v2/catalog/catalogitem.page?P=53793) |
| NXT ultrasonic (53792) | Two eyes in a grey housing shaped like a head | | [BrickLink 53792](https://www.bricklink.com/v2/catalog/catalogitem.page?P=53792) |
| NXT light, colour, sound | A red light or a lens (light, [colour 64892](https://www.bricklink.com/v2/catalog/catalogitem.page?P=64892)), a grille (sound, [55963](https://www.bricklink.com/v2/catalog/catalogitem.page?P=55963)) | | |

Look-alikes, and the one tell that separates them:

- touch or colour: a red cross plunger (touch, 4.4 cm long, at a bumper) or a round lens window (colour, 4.0 cm, usually low and facing the floor);
- colour or gyro: a window means colour;
- ultrasonic or infrared: eyes that stand out are ultrasonic, a flat dark face is infrared;
- large or medium motor: length against the brick (11 cm, about the brick's length, or 7 cm).

When the tell is not in the photo (the part seen from behind or from the side, too small, in shadow), the kind is assumed: keep its port's token and ask "Is the part at <place> a <kind a> or a <kind b>?". Never pick one. An IR remote or beacon is not on a port.

## Official models

When the robot looks like one of these, name it (state 0). The tells are what a photo shows; the ports and numbers are in the map's `builds.json` under the key, never here.

| Model (set) | `builds.json` key | Tells |
|---|---|---|
| Driving Base, Robot Educator (45544) | `educator_driving_base` | Brick flat on two large motors, two 56 mm wheels, a steel ball caster behind; attachments in front: colour sensor down, ultrasonic ahead, touch bumper, gyro, a medium-motor arm |
| Gyro Boy (45544) | `gyro_boy` | Brick standing upright on two 56 mm wheels and no caster; ultrasonic eyes on top, two arms; it balances |
| Puppy (45544) | `puppy` | Four legs, the brick as the body, a head on a neck |
| Color Sorter (45544) | `color_sorter` | A station: a belt and a feeder tray, the colour sensor over the belt, no wheels |
| Robot Arm H25 (45544) | `robot_arm_h25` | A crane-like arm on a turntable base, a gripper at its end, no wheels |
| Tank Bot (45544 + 45560) | `tank_bot` | Brick flat on a long body with black plastic tread-link tracks over 10-tooth sprockets on each side |
| Stair Climber (45544 + 45560) | `stair_climber` | Four big wheels front and back, a lifting frame under the body for climbing a step |
| Znap (45544 + 45560) | `znap` | A long low body on two wheels, a snapping jaw head with the ultrasonic sensor |
| Elephant (45544 + 45560) | `elephant` | Four legs, a long trunk, a big head |
| TRACK3R (31313) | `track3r` | Brick flat over two rubber tracks on small rims, the infrared sensor ahead, a tool in front (spinner, hammer, claw or bazooka) |
| EV3RSTORM (31313) | `ev3rstorm` | A humanoid on rubber tracks, the brick upright as the chest, the infrared sensor as the head, a bazooka arm |
| GRIPP3R (31313) | `gripp3r` | Rubber tracks and a large two-claw gripper in front, the infrared sensor on top |
| R3PTAR (31313) | `r3ptar` | A snake standing up, the infrared sensor as the head |
| SPIK3R (31313) | `spik3r` | A scorpion on legs, a claw in front and a tail over the back |

A model not in this table (the 31313 bonus models, a community build) is a custom robot: no build data.

**On a model's base.** A robot that has a model's drive (the Driving Base's two motors and wheels, Tank Bot's tracks) but other parts or another layout on it is built *on* that model, not the model. Take from the build only the drive: its drive ports, wheel diameter and axle track, assumed. Read every other part from the photo as for a custom robot. The build's other ports are not added; ask about them in question 14 ("Is there a gyro on port 2, as on the Driving Base?").

## Reading a build

Open `<clone>/packages/lego-parts/data/builds.json` and take the entry whose `key` is the model's.
- `ports`: keys `A`-`D` are motor ports, `1`-`4` the sensor ports `S1`-`S4`. Each `value` reads `<kind>, <role>`. `large motor` and `medium motor` are kinds; a bare `motor` means the build does not say: the kind comes from the photo (length against the brick, "Look-alikes"), else the one rule of questions.md row 4, and its token stays. Its `note` says why.
- A role that starts with `attachment:` is one of the model's alternative attachments: it enters the file only when that attachment is in the photo or the person names it. Every other port is a fixed part of the model and enters the file also when the photo does not show it.
- A port's `alt` lists sources that say something else. For the drive pair, write the `value`'s sides, put the `alt` in a note ("TRACK3R: the programs put the left track on B, the LDraw model on C"), and keep `left_right` whatever the person says about the model; for another port, keep its token.
- `wheel_diameter_mm.value` and `axle_track_mm.value` ÷ 10 are `wheel_diameter_cm` and `axle_track_cm`, assumed; `{"unknown": true}` means parts.md and the photo decide.
- `footprint_mm` (length, width, height), when it has a value, gives the footprint, assumed: `half_width_cm` is half the width; with tracks `front_cm` and `back_cm` are half the length each (the axle is the tracks' middle); with wheels, split the length at the wheel axle as the photo shows. Else "Scale".
- `note`: balancing, steering, walking, no drive. Each one is a row of robot-file.md "What a twin cannot have".
- A port that is not in `ports` is empty on that model: a person's yes to the model confirms it empty too.

## Where a port is

On an EV3 lying flat, screen up, with the screen end away from you, the output ports from left to right are `A B C D` (with the USB plug between B and C), and on the near end the inputs from left to right are `1 2 3 4`. A plug is confirmed only when you can read the letter beside it or count its place in the row and follow its cable to a part.

A port is **visibly empty** only when you see the socket's open dark slot, with nothing in it and no cable in front of it, and can place it in its row. A row seen at a slant where cables cover the sockets, or a port end out of the frame, is not read: its ports keep their tokens.

## Scale

With no ruler, the brick is the ruler. Keep every length assumed (`footprint`, `places`) unless it was measured.

1. Find the brick's long side in the photo (111.2 mm port end to port end, 72 mm across: the map's `electronics.json`, part 95646) and divide its length in pixels by 11.12: that is pixels per cm. In a photo at a slant, use a length that lies in the same plane as the one you measure.
2. Measure each length in pixels and divide; where a beam lies along it, count its holes instead: n holes are 0.8 × n cm.
3. Take wheel and tyre diameters from parts.md by what the part is, never by scaling; check the footprint against them (a 56 mm wheel is half the brick's length).

## More photos

Ask for the views that are missing, at most three of these four:

- the brick's two port ends, close enough to read `A B C D` and `1 2 3 4`;
- from above, the whole robot;
- from the side, at floor level, showing what touches the floor;
- for a robot under a shell or decoration: the same views with the shell off, or from underneath.
