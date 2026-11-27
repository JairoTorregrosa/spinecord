// What the twin's speaker would sound like: the brick's tones through WebAudio and sim.speaker's phrases through
// the browser's speech synthesis. Off until the person turns it on (browsers play nothing before a gesture).

export class Sound {
  private ctx: AudioContext | null = null;
  enabled = false;

  /**
   * Turns the sound on or off. Call it from the person's click: browsers start audio only inside a gesture.
   * Resolves with whether the browser really plays (false: it kept the audio blocked).
   */
  async setEnabled(on: boolean): Promise<boolean> {
    this.enabled = on;
    if (!on) {
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      await this.ctx?.suspend();
      return false;
    }
    this.ctx ??= new AudioContext();
    await this.ctx.resume();
    return this.ctx.state === "running";
  }

  /** One brick tone: `volume` in percent, as SOUND TONE gives it. */
  tone(hz: number, ms: number, volume: number): void {
    if (!this.enabled || !this.ctx || !(hz > 0) || !(ms > 0)) return;
    const ctx = this.ctx,
      t0 = ctx.currentTime,
      t1 = t0 + Math.min(ms, 5000) / 1000;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = Math.min(10000, Math.max(30, hz));
    const level = 0.06 * Math.min(1, Math.max(0, volume / 100));
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(level, t0 + 0.006);
    gain.gain.setValueAtTime(level, Math.max(t0 + 0.006, t1 - 0.01));
    gain.gain.linearRampToValueAtTime(0, t1);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t1 + 0.02);
  }

  speak(text: string): void {
    if (!this.enabled || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = looksSpanish(text) ? "es-ES" : "en-US";
    speechSynthesis.speak(u);
  }
}

function looksSpanish(text: string): boolean {
  return (
    /[áéíóúñ¿¡]/i.test(text) ||
    /\b(hola|el|la|los|las|que|de|en|un|una|estoy|soy|voy|para|con|por|gracias|listo)\b/i.test(text)
  );
}
