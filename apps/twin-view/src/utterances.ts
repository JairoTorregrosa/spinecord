// Which spoken message may still be sent. The recognizer hands over a transcript up to 3 s after the person let
// go, and the page then waits for the turn before to end: a Stop in that time must win, so the transcript that was
// being heard is dropped. Each utterance gets a ticket when the person starts talking; a Stop voids every ticket
// given before it. Typed text needs none: it is sent at once. Pure: no DOM, no I/O.

export class Utterances {
  private last = 0;
  private voidedUpTo = 0;
  /** The person starts talking: the ticket of what they will say. */
  begin(): number {
    return ++this.last;
  }
  /**
   * A Stop: nothing heard before it is sent. `keep`: a stop word spoken inside the utterance of that ticket, which
   * goes on ("para qué sirve…" is sent at the release); every utterance before it is dropped.
   */
  stop(keep?: number): void {
    this.voidedUpTo = keep === undefined ? this.last : Math.max(this.voidedUpTo, keep - 1);
  }
  /** Whether the utterance of `ticket` may still be sent. */
  live(ticket: number): boolean {
    return ticket > this.voidedUpTo;
  }
}
