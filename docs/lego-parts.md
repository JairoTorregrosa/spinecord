# LEGO parts: what an EV3 robot is made of

A LEGO robot is built from a finite set of real parts on a fixed grid. Before you describe a robot from a photo, name its parts from this page. Then read their sizes from the data. Do not estimate them.

Data: [`packages/lego-parts/data/`](../packages/lego-parts/data/). Each number in those files carries its source URL, or is marked unknown with the reason.

## The grid in five lines

- 1 module = 8 mm. That is the distance between studs and between Technic holes. LDraw measures it as 20 LDU (1 LDU = 0.4 mm).
- A plate is 3.2 mm tall and a brick is 9.6 mm. A brick plus two plates is 16 mm, which is 2 modules, so holes line up vertically too.
- A beam with n holes is 8n − 0.8 mm long. A thick beam is 8 mm along its holes and 7.2 mm across; a thin beam is 4 mm thick.
- Pin holes are 4.8 mm in diameter. An axle is 4.8 mm across its cross. An axle n units long measures 8n − 0.4 mm.
- Positions are half-module multiples (10 LDU). `ldraw-geometry.json` gives every part's holes in its own LDraw frame (LDU, −Y up).

## Electronics

Sizes are length × width × height, read from the LDraw bounding box. The full data is in [`electronics.json`](../packages/lego-parts/data/electronics.json). The ports, outputs and sensing elements, in each part's frame, are under `features`.

| Part | Design / product | Size (mm) | Mass | How to recognise it |
|---|---|---|---|---|
| EV3 Intelligent Brick | 95646 / 45500 | 111.2 × 72 × 43.6 (50.8 with the rechargeable battery) | 180 g | The biggest part: white, with a black screen at one end and a dark grey button cross below it. Motor ports A–D plus the PC port are at the screen end; sensor ports 1–4 are at the other end. |
| Large Servo Motor | 95658 / 45502 | 107.2 × 40 × 55.2 | 80.7 g | A long, boot-shaped body, white and light grey. A red round hub turns at the front end; the cable socket is at the back. Usually one per wheel. |
| Medium Servo Motor | 99455 / 45503 | 72.4 × 24 × 31.2 | 38.3 g | A small box with a red axle-hole output on one end face. As long as the brick is wide. |
| Touch Sensor | 95648 / 45507 | 43.6 × 24 × 31.2 | 14.9 g | Small, with a red button on its front. The button has a cross hole. |
| Color Sensor | 95650 / 45506 | 39.6 × 24 × 31.2 | 13.7 g | Small, with one round lens in a black face. It usually points down, close to the floor. |
| Gyro Sensor | 99380 / 45505 | 39.6 × 24 × 31.2 | 12.6 g | Same body as the colour sensor but no lens. Two red arrows on one face show the axis it measures. |
| Ultrasonic Sensor | 95652 / 45504 | 47.4 × 55.2 × 31.2 | 24 g | Two big round "eyes" 32 mm apart, red-rimmed and black. |
| Infrared Sensor | 95654 / 45509 | 47.6 × 55.2 × 31.2 | 19.4 g | Same size as the ultrasonic, but its front is two flat dark-red windows instead of eyes. |
| IR Beacon / remote | 72156 / 45508 | 63.2 × 40 × 23.2 | 26.7 g | A white handheld with grey buttons and a red channel slider. It has no cable. |
| Rechargeable battery | 95656 / 45501 | under the brick | 131.3 g | A light grey tray that replaces the brick's white bottom. It adds 7.2 mm of height. |
| Cables 25 / 35 / 50 cm | 11145, 55805 (11146), 55806 (11147) | flat, black | 10–13 g | Flat black cables with a plug at each end. Which sets hold them: 31313 and 45544 have 4 × 25, 2 × 35 and 1 × 50 each. |

Which sets hold which electronics: the home set 31313 has the IR sensor and the beacon. The Education core set 45544 has the ultrasonic, the gyro and the battery. Both have the brick, two large motors, one medium motor, a colour sensor and a touch sensor (45544 has two). The Expansion set 45560 has no electronics.

## What rolls

The full data is in [`rolling.json`](../packages/lego-parts/data/rolling.json). Diameters come from LDraw.

| Part | Ø × width (mm) | Sets | How to recognise it |
|---|---|---|---|
| Tyre 41897 on rim 56908 | 56 × 28 (rim 43.2 × 26.4) | 45544 ×2, 45560 ×2 | Wide black street tyre on a light grey rim with 6 pin holes. This is the Education driving base's wheel; the brick is about two wheels long. |
| Tyre 44309 on rim 56145 | 43.2 × 21.6 (rim 30.4 × 20) | 31313 ×4, 45560 ×2 | A smaller black tyre on a ribbed rim; the rim is black in 31313. |
| Tyre 44771 on rim 15038 | 68.8 × 35.2 (rim 56 × 33.6) | 45560 ×4 | The biggest wheel; nearly as tall as the brick is wide. |
| Rubber track 53992 on two rims 56145 | 36.8 tall over the rims, 20 wide | 31313 ×2 | A black rubber band with 36 ridges, used by TRACK3R. |
| Tread links 88323 on sprocket 57519 | about 54–55 rolling Ø, 38.4 wide | 45544 ×54 links + ×4 sprockets, 45560 ×5 + ×2 | Black plastic links clicked into a track over 10-tooth sprockets 40.8 mm across. |
| Steel ball 99948 in receptacle 92911 | 18 | 45544 ×1 | A chrome ball under the rear of the Education driving base. |
| Small wheels | 24 × 13.6 (89201), 16.8 (55982, 13971), 11.2 (42610), pulley 24 (4185) | 45560, 31313 | These are rarely drive wheels. |

The structural parts are in [`structural.json`](../packages/lego-parts/data/structural.json): beams 2–15, bent beams, the 5 × 7 and 5 × 11 frames, axles 2–12, pins and connectors. Every LDraw part they name has its holes listed in [`ldraw-geometry.json`](../packages/lego-parts/data/ldraw-geometry.json).

The complete inventories of 31313, 45544 and 45560 are in [`sets.json`](../packages/lego-parts/data/sets.json). Use them to answer "which parts can this person possibly have".

## Official builds

The data is in [`builds.json`](../packages/lego-parts/data/builds.json). Each port value reads `<kind>, <role>`; `motor, …` means the program does not say large or medium. Ports come from the Pybricks official-model programs unless the row says otherwise; motor kinds of the 31313 models from the ev3dev demos. Placements are sourced only for TRACK3R.

| Build | Set | Motors | Sensors | Wheel Ø / axle track (mm) |
|---|---|---|---|---|
| Education driving base | 45544 | B large left, C large right, A medium attachment (ev3dev demo) | 1 touch, 2 gyro (default ports), 3 colour, 4 ultrasonic | 55.5 / 104 (older example: 56 / 114) |
| Gyro Boy | 45544 | D left wheel, A right wheel, C arms | 1 colour, 2 gyro, 4 ultrasonic | unknown; it balances |
| Puppy | 45544 | D left leg, A right leg, C head | 1 touch, 4 colour | no drive |
| Color Sorter | 45544 | D belt, A feeder | 1 touch, 3 colour | no drive |
| Robot Arm H25 | 45544 | A gripper, B elbow, C base | 1 touch, 3 colour | no drive |
| Tank Bot | 45544 + 45560 | B large left track, C large right track | 4 gyro | 54 / 200 |
| Stair Climber | 45544 + 45560 | B front wheels, A rear wheels, D lift | 2 gyro, 3 touch | unknown; no pair |
| Znap | 45544 + 45560 | A left wheel, D right wheel, B head | 3 ultrasonic | 45 / 150 |
| Elephant | 45544 + 45560 | A legs, B trunk, D neck | 1 touch, 4 colour | walks |
| TRACK3R | 31313 | B and C large tracks, A medium tool | 4 infrared | 36.8 / 176 (LDraw model) |
| EV3RSTORM | 31313 | B large left track, C large right track, A medium bazooka | 1 touch, 3 colour, 4 infrared | 36.8 (track) / 102 |
| GRIPP3R | 31313 | B large left track, C large right track, A medium gripper | 1 touch, 4 infrared | 36.8 (track) / 115 |
| R3PTAR | 31313 | A medium steering, B large drive, D large striker | 1 touch, 4 infrared | steers; no pair |
| SPIK3R | 31313 | A medium claw, B large legs, D large tail | 1 touch, 3 colour, 4 infrared | walks |

The Education models' programs do not name motor kinds; 45544 holds two large motors and one medium and 45560 none, so a three-motor Education model has exactly one medium. TRACK3R's left track is B in both programs and C in the LDraw model's cable routing: unresolved, both are in the data. Not in the map: the 31313 bonus models (BOBB3E, DINOR3X, EV3D4, KRAZ3, MR-B3AM, RAC3 TRUCK, ROBODOZ3R, WACK3M, EL3CTRIC GUITAR), and every footprint but TRACK3R's.

## Attribution

The geometry comes from the LDraw parts library, © its authors, licensed CC BY 4.0 (some parts are CC BY 2.0): <https://library.ldraw.org>. The TRACK3R placements come from Philippe Hurbain's model, CC BY 2.0. The inventories are from Rebrickable.
