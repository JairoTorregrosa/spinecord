// The level meter of the microphone, on the browser's audio thread: the loudness of what the microphone hears,
// 0..100 (-60 dBFS .. 0 dBFS), posted at most 10 times per second. It runs from the audio itself, never from a
// timer, so a hidden tab reports it as often as a visible one. Bundled on its own and served as level.js.
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: { postMessage(v: unknown): void };
}

const POSTS_PER_S = 10;

class Level extends AudioWorkletProcessor {
  private sum = 0;
  private n = 0;
  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) this.sum += ch[i]! * ch[i]!;
      this.n += ch.length;
    }
    if (this.n >= sampleRate / POSTS_PER_S) {
      const rms = Math.sqrt(this.sum / this.n);
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      this.port.postMessage(Math.max(0, Math.min(100, ((db + 60) / 60) * 100)));
      this.sum = 0;
      this.n = 0;
    }
    return true;
  }
}
registerProcessor("spinecord-level", Level);
