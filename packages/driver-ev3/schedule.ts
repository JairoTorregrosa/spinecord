// When to ask the brick about a running operation.
//
// Every question is a packet, and a packet costs a round trip (USB HID: about 2 ms), so the provider does
// not ask on a fixed tick. It asks when an answer can change what it does: when the encoder may have
// reached a degree target (the provider brakes there), and when the brick ends the operation by itself at
// its time bound. Near either moment it falls back to the fixed tick `pollMs`, so the precision of the
// early brake is the one a fixed tick gives. Pure: no clock, no I/O.

/**
 * A degree target is approached in steps of a share of the time still needed. Until the encoder has shown
 * how fast the motor really turns, the calibration is not trusted: half the time, which still catches a
 * motor twice as fast as configured (a medium motor on a large motor's calibration is 1.5 times).
 */
export const APPROACH_UNSEEN = 0.5;
/** Once the speed was seen on the encoder: close to the target in one step, with room for the speed still rising. */
export const APPROACH_SEEN = 0.9;
/** The encoder counts whole degrees: a speed measured over less than this is noise, ms. */
export const MIN_RATE_WINDOW_MS = 20;
/** A question about the end of the operation is aimed this long after the end, so it does not land a moment too early and cost a second one. */
export const END_SLACK_MS = 1;

export interface PollState {
  /** The fixed tick, ms: the shortest wait, used near a target and after a missed end. */
  pollMs: number;
  /** Round trip of one packet, ms. A question sent now is answered about the brick half of this later. */
  rttMs: number;
  /** ms from the last answer until the brick ends the operation by itself (negative: it should have ended). */
  endInMs: number;
  /** Degree target only: degrees still to go at the last answer. */
  remainingDeg?: number;
  /** Degree target only: the fastest the motor is expected to turn, deg/s (> 0). */
  rateDegS?: number;
  /** Degree target only: rateDegS was checked against the encoder (see observedRate). */
  rateSeen?: boolean;
}

/** ms to wait after the last answer before sending the next question. Never under pollMs. */
export function nextPollDelay(s: PollState): number {
  let wait = s.endInMs + END_SLACK_MS;
  if (s.remainingDeg !== undefined) {
    if (!(s.rateDegS! > 0)) throw new RangeError(`rateDegS must be > 0, got ${s.rateDegS}`);
    const share = s.rateSeen ? APPROACH_SEEN : APPROACH_UNSEEN;
    wait = Math.min(wait, (Math.max(0, s.remainingDeg) / s.rateDegS!) * 1000 * share);
  }
  // The answer describes the brick one round trip after the last one, at the earliest.
  return Math.max(s.pollMs, wait - s.rttMs);
}

/** Speed between two answers, deg/s, or null when they are too close together to tell. */
export function observedRate(movedDeg: number, overMs: number): number | null {
  return overMs >= MIN_RATE_WINDOW_MS ? (Math.max(0, movedDeg) / overMs) * 1000 : null;
}
