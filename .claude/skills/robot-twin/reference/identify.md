# Reading a photo of a LEGO robot

Sizes are the parts' bounding boxes from BrickLink's catalogue (marked verified there), checked 2026-11-27. They are the ruler when the photo has none.

## What the photo shows

| It is | Tells |
|---|---|
| A photo of a built robot | Real light and shadow, a floor or table, cables that sag, parts slightly out of line, often a hand, a mat or a room |
| An instruction drawing | Flat shading, no shadow on a floor, a step number, a parts call-out box (`1x`, `2x`), an arrow showing where a part goes, white background |
| A render or box art | Perfect parts, glossy, no cables or cables drawn ideal, logo or set number, staged background |
| A slide, poster or screen | A frame, text blocks, a projector's keystone, a monitor bezel, moiré, other images beside it |
| Several robots | More than one drive base or more than one brick |

| Brick | Tells | spinecord |
|---|---|---|
| **EV3** | Dark grey and light grey, about 11-12 × 7-7.6 cm ([BrickLink 95646c01](https://www.bricklink.com/v2/catalog/catalogitem.page?P=95646c01)). A grey monochrome screen at one end of the top face; below it six buttons: a centre button inside a ring of four arrow buttons that light green, orange or red, and a back button at the screen's corner. `EV3` printed on it. **Four** output ports `A B C D` on the end beside the screen, **four** input ports `1 2 3 4` on the other end; the USB plug between them on the A-D end | yes |
| NXT | Light grey and white, an **orange** square button with two grey arrow buttons, `NXT` printed, a smaller screen. **Three** output ports `A B C` on one end, four inputs `1 2 3 4` on the other | no: stop |
| SPIKE Prime, Robot Inventor | A square hub, no screen: a **5 × 5 grid of white lights** and one round button; **six** ports `A`-`F` along two sides. SPIKE Prime is yellow and white or grey, Robot Inventor teal and black. Each motor's flat cable is fixed to the motor | no: stop |
| SPIKE Essential, WeDo, Powered Up | A small hub with two ports and a light | no: stop |
| RCX | A large **yellow** brick with a small screen and three plus three square stud ports | no: stop |

## Motors

| Part | Tells | Size |
|---|---|---|
| EV3 large motor | Long L-shaped housing, white and dark grey; the round end turns a **red** hub with a cross hole; the cable plugs into a socket at the square end | 11.1 × 5.9 × 4.0 cm ([BrickLink 95658](https://www.bricklink.com/v2/catalog/catalogitem.page?P=95658)) |
| EV3 medium motor | A compact block, white and grey; the **red** output on its short front face, axle along its length; many pin holes around | 7.2 × 3.1 × 2.4 cm ([BrickLink 99455](https://www.bricklink.com/v2/catalog/catalogitem.page?P=99455)) |
| NXT motor | The large motor's shape, light grey, an **orange** hub | 10.8 × 5.3 × 4.0 cm ([BrickLink 53787](https://www.bricklink.com/v2/catalog/catalogitem.page?P=53787)) |

An NXT motor on an EV3 brick works; write it as `"large"` and add a note. A motor whose cable goes nowhere visible still counts: ask which port.

## Sensors

| Part | Tells | Faces | Size |
|---|---|---|---|
| EV3 touch | Box with a **red cross-shaped plunger** on one end | where the plunger points | 6 × 3 × 3 studs, 4.4 × 3.1 × 2.4 cm ([BrickLink 95648](https://www.bricklink.com/v2/catalog/catalogitem.page?P=95648)) |
| EV3 colour | Small dark box, a round window with a lens on one face; the window glows red, blue or white when it is on | where the window points, usually down at the floor | 4.0 × 3.1 × 2.4 cm ([BrickLink 95650](https://www.bricklink.com/v2/catalog/catalogitem.page?P=95650)) |
| EV3 gyro | The colour sensor's box but **no window**; curved arrows printed on top (the axis it measures) | any; position does not matter | 4.0 × 3.1 × 2.4 cm ([BrickLink 99380](https://www.bricklink.com/v2/catalog/catalogitem.page?P=99380)) |
| EV3 ultrasonic | **Two round eyes** that stand out, side by side, with a ring around each that glows red when on | where the eyes point | 7 × 6 × 3 studs, 5.8 × 4.8 × 3.2 cm ([BrickLink 95652](https://www.bricklink.com/v2/catalog/catalogitem.page?P=95652)) |
| EV3 infrared | Same size, but a **flat, dark, glossy** front panel with two lenses behind it, nothing standing out | where the dark panel points | 5.8 × 4.8 × 3.1 cm ([BrickLink 95654](https://www.bricklink.com/v2/catalog/catalogitem.page?P=95654)) |
| NXT touch | An **orange** plunger, light grey box | | [BrickLink 53793](https://www.bricklink.com/v2/catalog/catalogitem.page?P=53793) |
| NXT ultrasonic | Two eyes in a grey housing shaped like a head | | [BrickLink 53792](https://www.bricklink.com/v2/catalog/catalogitem.page?P=53792) |
| NXT light, colour, sound | A red light or a lens (light, [colour 64892](https://www.bricklink.com/v2/catalog/catalogitem.page?P=64892)), a grille (sound, [55963](https://www.bricklink.com/v2/catalog/catalogitem.page?P=55963)) | | |

Ultrasonic or infrared is the look-alike that matters: eyes that stand out are ultrasonic; a flat dark face is infrared. Gyro or colour: a window is colour. An IR remote or beacon is not on a port.

## Where a port is

On an EV3 lying flat, screen up, with the screen end away from you, the output ports from left to right are `A B C D` (with the USB plug between B and C), and on the near end the inputs from left to right are `1 2 3 4`. A plug is confirmed only when you can read the letter beside it or count its place in the row and follow its cable to a part.

## Scale

With no ruler, measure against the parts:

- the EV3 brick: about 11.5 cm from port end to port end, 7.5 cm across;
- a large motor: about 11 cm long;
- a LEGO hole or stud: 0.8 cm from centre to centre ([LUGNET, measured 7.986 mm](https://www.lugnet.com/~330/FAQ/Build/dimensions)), so a beam of n holes is 0.8 × n cm long.

A length read this way is still `footprint` or `places`, assumed, unless it was measured.

## More photos

Ask for what is missing, at most three:

- the brick's two port ends, close enough to read `A B C D` and `1 2 3 4`;
- from above, the whole robot;
- from the side, at floor level, showing what touches the floor;
- for a robot under a shell or decoration: the same views with the shell off, or from underneath.
