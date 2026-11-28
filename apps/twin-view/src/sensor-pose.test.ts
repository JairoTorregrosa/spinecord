import { describe, expect, test } from "bun:test";
import { SENSOR } from "./dims";
import { place } from "./look";
import {
  centreForPose,
  distancePort,
  eyeOffset,
  eyeOfPlace,
  facingYaw,
  rayEnd,
  rayStart,
  resolveDistancePose,
  wrapDeg,
  type SensorPose,
} from "./sensor-pose";

const EYE = (k: "ir" | "ultrasonic") => eyeOffset(k, SENSOR[k]);
const DEFAULTS: SensorPose = { x_cm: 8, y_cm: 0, z_cm: 6, yaw_deg: 0 };
const WHERE = { body: "r.json: twin.body", place: "r.json: twin.view.sensors.4" };

describe("the distance sensor's pose: one point and heading for the reading, the rays and the drawing", () => {
  test("the eye is the parts map's own point: the infrared's front face, the ultrasonic's beam centre", () => {
    const [x, y, z] = EYE("ir");
    const ir = SENSOR.ir;
    expect(x).toBeCloseTo(ir.at.front_face![0] - (ir.min[0] + ir.max[0]) / 2, 9);
    expect(y).toBeCloseTo(0, 9);
    expect(z).toBeCloseTo(ir.at.front_face![2] - (ir.min[2] + ir.max[2]) / 2, 9);
    expect(x).toBeGreaterThan(2); // the face is well ahead of the box's centre
    expect(EYE("ultrasonic")[0]).toBeCloseTo(
      SENSOR.ultrasonic.at.beam_centre![0] - (SENSOR.ultrasonic.min[0] + SENSOR.ultrasonic.max[0]) / 2,
      9,
    );
  });

  test("a place's eye and the place drawn for a pose are the same point, off-centre and turned", () => {
    for (const kind of ["ir", "ultrasonic"] as const) {
      const pose: SensorPose = { x_cm: 6.5, y_cm: -4.2, z_cm: 12.4, yaw_deg: 20 };
      const c = centreForPose(EYE(kind), pose);
      const eye = eyeOfPlace(EYE(kind), { ...c, facing: "forward", yaw: 20 }, { facing: true, yaw: true });
      expect(eye.x!).toBeCloseTo(pose.x_cm, 9);
      expect(eye.y!).toBeCloseTo(pose.y_cm, 9);
      expect(eye.z!).toBeCloseTo(pose.z_cm, 9);
      expect(eye.yaw).toBe(20);
    }
    // facing left is 90 degrees, and the eye sits on that side of the box's centre
    const left = eyeOfPlace(EYE("ir"), { x: 0, y: 0, z: 10, facing: "left", yaw: 0 }, { facing: true, yaw: false });
    expect(left.x!).toBeCloseTo(0, 9);
    expect(left.y!).toBeCloseTo(EYE("ir")[0], 9);
    expect(left.yaw).toBe(90);
  });

  test("the look's place says only what it gives: no facing and no yaw_deg leave the heading to the body", () => {
    const eye = eyeOfPlace(EYE("ir"), place({ y_cm: 4.6, z_cm: 19.6 }), { facing: false, yaw: false });
    expect(eye.x).toBeNull();
    expect(eye.y).toBeCloseTo(4.6, 9);
    expect(eye.z!).toBeCloseTo(19.6 + EYE("ir")[2], 9);
    expect(eye.yaw).toBeNull();
    // up or down has no heading the physics can read along: refused in plain words
    expect(() =>
      eyeOfPlace(EYE("ir"), place({ x_cm: 1, y_cm: 1, z_cm: 9, facing: "up" }), { facing: true, yaw: false }),
    ).toThrow(
      'faces up: a distance sensor reads level, along a heading; give it "facing" forward, back, left or right',
    );
    expect(facingYaw("back", 10)).toBe(-170);
    expect(wrapDeg(540)).toBe(180);
    expect(wrapDeg(-190)).toBe(170);
  });

  test("resolved: the body's x and z win, the place fills y, z and yaw where the body is silent", () => {
    const eye = { x: 7.4, y: -4.2, z: 12.4, yaw: 20 };
    expect(resolveDistancePose({ distance_sensor_x_cm: 6 }, eye, DEFAULTS, WHERE)).toEqual({
      x_cm: 6,
      y_cm: -4.2,
      z_cm: 12.4,
      yaw_deg: 20,
    });
    // a skill-written file: body x only, no place: the defaults, as the physics always had them
    expect(resolveDistancePose({ distance_sensor_x_cm: 6 }, null, DEFAULTS, WHERE)).toEqual({ ...DEFAULTS, x_cm: 6 });
    // the same side and direction written twice (within 0.5 cm and 1 degree) is one pose
    expect(
      resolveDistancePose({ distance_sensor_y_cm: -4, distance_sensor_yaw_deg: 20.5 }, eye, DEFAULTS, WHERE).y_cm,
    ).toBe(-4);
  });

  test("refused, naming both, when the body and the place put the eye on another side or looking elsewhere", () => {
    const eye = { x: null, y: -4.2, z: null, yaw: 20 };
    expect(() => resolveDistancePose({ distance_sensor_y_cm: 4.2 }, eye, DEFAULTS, WHERE)).toThrow(
      "r.json: twin.view.sensors.4 puts the distance sensor's eye at distance_sensor_y_cm -4.2, and r.json: twin.body.distance_sensor_y_cm is 4.2",
    );
    expect(() => resolveDistancePose({ distance_sensor_yaw_deg: 0 }, eye, DEFAULTS, WHERE)).toThrow(
      "distance_sensor_yaw_deg 20",
    );
  });

  test("the rays start at the eye and leave along its heading (three.js frame: y up, z to the right)", () => {
    const from: SensorPose = { x_cm: 6, y_cm: 4, z_cm: 20, yaw_deg: 90 };
    expect(rayStart(from)).toEqual([6, 20, -4]);
    const ahead = rayEnd(from, 0, 10); // looking left: 10 cm further left
    expect(ahead[0]).toBeCloseTo(6, 9);
    expect(ahead[1]).toBe(20);
    expect(ahead[2]).toBeCloseTo(-14, 9);
    const side = rayEnd(from, -90, 10); // 90 degrees right of a sensor looking left: straight ahead
    expect(side[0]).toBeCloseTo(16, 9);
    expect(side[2]).toBeCloseTo(-4, 9);
  });

  test("the pose belongs to the lowest port with an ultrasonic or an infrared", () => {
    expect(distancePort({ "1": "touch", "3": "ir", "2": "ultrasonic" })).toEqual({ port: "2", kind: "ultrasonic" });
    expect(distancePort({ "1": "color" })).toBeNull();
  });
});
