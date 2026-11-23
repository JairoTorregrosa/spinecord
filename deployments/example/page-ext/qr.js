// A QR reader from the lent camera (docs/peripheral-pages.md). It decodes with the browser's own BarcodeDetector,
// feature-detected: Chrome on Android and on macOS have it; where the browser has none (Safari on iOS, Firefox,
// Chrome on Windows and Linux) the device is not lent and the page lists it as unavailable with the reason. The
// frame never leaves the page: only the text of the code goes to the robot.
const Detector = globalThis.BarcodeDetector;
let last = "";
let count = 0;
spinecord.device({
  id: "qr",
  kind: "code_reader",
  description: "Reads a QR code in front of the lent camera when asked.",
  available: () => typeof Detector === "function" || "this browser has no barcode detector (BarcodeDetector)",
  channels: [
    { name: "last_text", type: "string", description: 'Text of the latest code read; "" when none.' },
    { name: "read_count", type: "number", description: "Codes read since the page joined." },
  ],
  commands: [
    {
      name: "scan",
      description: "Looks for a QR code for up to max_ms. measured: {found, text}; reason timeout when none was found.",
      params: {
        type: "object",
        properties: { max_ms: { type: "integer", minimum: 200, maximum: 5000 } },
        required: ["max_ms"],
        additionalProperties: false,
      },
      bound: { kind: "ms", params: ["max_ms"], max: 5000 },
      moves: false,
    },
  ],
  read: () => ({ last_text: last, read_count: count }),
  async run(_command, { max_ms }, signal) {
    const detector = new Detector({ formats: ["qr_code"] });
    const end = Date.now() + max_ms;
    while (!signal.aborted && Date.now() < end) {
      const frame = await spinecord.cameraFrame();
      let codes;
      try {
        codes = await detector.detect(frame);
      } finally {
        frame.close();
      }
      if (codes.length) {
        last = codes[0].rawValue;
        count++;
        return { found: true, text: last };
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return signal.aborted ? { found: false, text: "" } : spinecord.ended("timeout", { found: false, text: "" });
  },
});
