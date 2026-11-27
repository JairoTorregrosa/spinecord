import { expect, test } from "bun:test";
import { Utterances } from "./utterances";

test("a Stop drops what was being heard, and the next utterance is sent again", () => {
  const u = new Utterances();
  const first = u.begin();
  expect(u.live(first)).toBe(true);
  // the person let go, the recognizer still works on it, and Stop is pressed: the transcript is not sent
  u.stop();
  expect(u.live(first)).toBe(false);
  // the person starts talking again: that utterance is sent
  const second = u.begin();
  expect(u.live(second)).toBe(true);
  expect(u.live(first)).toBe(false);
  // a second Stop voids it too; one with nothing heard since changes nothing for what comes next
  u.stop();
  u.stop();
  expect(u.live(second)).toBe(false);
  expect(u.live(u.begin())).toBe(true);
});

test("a stop word spoken while talking drops what was said before, and keeps the sentence it is in", () => {
  const u = new Utterances();
  const before = u.begin(); // "gira a la izquierda", let go, still waiting to be sent
  const now = u.begin(); // "para…", and the person still talks
  u.stop(now);
  expect(u.live(before)).toBe(false);
  expect(u.live(now)).toBe(true);
});
