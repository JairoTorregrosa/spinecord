// The chat panel of the 3D view (`--chat`, CONTRACT §6, experimental). Built only when the process's hello
// says the chat is on: without it the page is exactly what it was. The person types or holds the talk button;
// the robot answers in text and in its voice while the scene moves; the stop button and a spoken "para" stop it
// at once (the process stops the robot itself, never through Claude). The panel takes the place of the list of
// MCP calls, and shows the calls in its own timeline: one story of what was said and what was done.
import type { ChatPageMessage, ChatServerMessage, ChatState, ChatStatus, ChatVia } from "./chat-messages";
import { CHAT_TEXT_MAX, isStopUtterance } from "./chat-messages";
import css from "./chat.css" with { type: "text" };
import type { CallEnd, CallStart } from "./messages";
import { TOOL, glance } from "./toolwords";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** What the chat's states look like: an icon, the page's words, a colour class. */
const STATE: Record<ChatState | "listening" | "speaking" | "offline", [string, string, string]> = {
  starting: ["◌", "Despertando", "warn"],
  idle: ["●", "Listo", "ok"],
  thinking: ["◐", "Pensando", "busy"],
  acting: ["⚙", "Actuando", "busy"],
  stopping: ["■", "Parando", "bad"],
  off: ["✕", "Apagado", "bad"],
  listening: ["🎙", "Escuchando", "rec"],
  speaking: ["🔊", "Hablando", "ok"],
  offline: ["✕", "Sin conexión", "bad"],
};
/** Why the chat is off, and what the person does about it. */
const OFF: Record<string, string> = {
  no_login:
    "Claude no tiene con qué pagar en este computador. En una terminal: ant auth login, y arranca spinecord con ANTHROPIC_PROFILE puesto.",
  start_failed: "El chat no pudo arrancar. Cierra y vuelve a abrir spinecord con --chat.",
  budget: "Se gastó el presupuesto de esta sesión. Vuelve a abrir spinecord (o súbelo con --chat-usd).",
  session_ended: "La sesión con Claude terminó. Vuelve a abrir spinecord con --chat.",
  ending: "spinecord se está cerrando.",
};
/** Why a move ended before doing all it was asked, in the person's words. */
const REASON: Record<string, string> = {
  preempted: "■ parado",
  stalled: "⚠ bloqueado",
  timeout: "⚠ sin tiempo",
  clamped: "⚠ recortado",
  condition_met: "✓ condición",
};
const SUGGESTIONS = ["Avanza 30 cm y gira a la izquierda", "¿Qué tienes delante?", "Da una vuelta completa"];
const REFUSED: Record<string, string> = {
  busy: "Espera a que termine, o pulsa Parar",
  off: "El chat está apagado",
  invalid: "Mensaje no válido (máximo 400 caracteres)",
};

// ---------------------------------------------------------------- the ear: speech to text in the browser

type SR = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  processLocally?: boolean;
  onresult: ((e: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
};
type SRClass = (new () => SR) & {
  available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (o: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
};
const SRCtor = (): SRClass | null =>
  ((window as unknown as { SpeechRecognition?: SRClass }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: SRClass }).webkitSpeechRecognition ??
    null) as SRClass | null;

/** Where the audio of the browser's recognizer goes: this computer, or the browser's maker. */
type EarWhere = "local" | "google" | "microsoft" | "none";

/**
 * The browser's speech recognition. With an audio track it listens to that track (a recorded WAV in a test
 * goes through here exactly like the microphone); without one the browser opens the microphone itself.
 */
class Ear {
  where: EarWhere = "none";
  private rec: SR | null = null;
  private final = "";
  private interim = "";
  private ended: (() => void) | null = null;
  constructor(public lang: string) {}

  /** Until the person asks for recognition on this computer, it is the browser maker's service (said on the button). */
  reset(): void {
    this.where = !SRCtor() ? "none" : navigator.userAgent.includes("Edg/") ? "microsoft" : "google";
  }

  /**
   * The person asked for recognition on this computer (a click: the browser may download its language pack).
   * Asked only then, never at load: in a browser build without on-device recognition (a headless shell, plain
   * Chromium) the question kills the page's renderer ("No binder found for OnDeviceSpeechRecognition"), so it is
   * asked only in Google Chrome and Microsoft Edge, and only by the person's own click.
   */
  async useLocal(): Promise<"local" | "unavailable" | "failed"> {
    const C = SRCtor();
    const brands = (navigator as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands ?? [];
    if (!C?.available || !brands.some((b) => b.brand === "Google Chrome" || b.brand === "Microsoft Edge"))
      return "unavailable";
    try {
      const o = { langs: [this.lang], processLocally: true };
      let state = await C.available(o);
      if ((state === "downloadable" || state === "downloading") && C.install && (await C.install(o)))
        state = await C.available(o);
      if (state !== "available") return "unavailable";
      this.where = "local";
      return "local";
    } catch {
      return "failed";
    }
  }

  start(o: { track?: MediaStreamTrack; onText: (text: string) => void; onError: (code: string) => void }): void {
    const C = SRCtor();
    if (!C) return o.onError("unsupported");
    const rec = new C();
    rec.lang = this.lang;
    rec.interimResults = true;
    rec.continuous = true;
    if (this.where === "local") rec.processLocally = true;
    this.final = this.interim = "";
    rec.onresult = (e) => {
      let fin = "",
        mid = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) fin += r[0].transcript;
        else mid += r[0].transcript;
      }
      this.final = fin;
      this.interim = mid;
      o.onText(`${fin}${mid}`.trim());
    };
    rec.onerror = (e) => {
      if (e.error !== "aborted" && e.error !== "no-speech") o.onError(e.error);
    };
    rec.onend = () => {
      this.rec = null;
      this.ended?.();
    };
    this.rec = rec;
    if (o.track) rec.start(o.track);
    else rec.start();
  }

  /** Stops listening; resolves with what was heard (at most 3 s after the release). */
  finish(): Promise<string> {
    const rec = this.rec;
    if (!rec) return Promise.resolve(`${this.final}${this.interim}`.trim());
    return new Promise((resolve) => {
      const done = () => resolve(`${this.final}${this.interim}`.trim());
      const t = setTimeout(() => {
        rec.abort();
        done();
      }, 3000);
      this.ended = () => {
        clearTimeout(t);
        this.ended = null;
        done();
      };
      rec.stop();
    });
  }

  abort(): void {
    this.rec?.abort();
    this.rec = null;
  }
}

// ---------------------------------------------------------------- the voice: the robot talks

/**
 * The robot's voice: the browser's speech synthesis, one voice for Claude's words and for the phrases of the
 * simulated speaker. A voice of this computer is preferred (a network voice sends the text to the browser's
 * maker); the panel names the one in use. Claude's text is spoken a sentence at a time as it streams.
 */
class Voice {
  voice: SpeechSynthesisVoice | null = null;
  on = true;
  private buf = "";
  private pending = 0;
  constructor(
    private lang: string,
    private readonly changed: () => void,
  ) {
    if (!("speechSynthesis" in window)) return;
    this.pick();
    speechSynthesis.addEventListener("voiceschanged", () => this.pick());
  }
  setLang(lang: string): void {
    this.lang = lang;
    this.pick();
  }
  private pick(): void {
    const base = this.lang.slice(0, 2);
    const all = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(base));
    const score = (v: SpeechSynthesisVoice) =>
      (v.localService ? 4 : 0) + (v.lang === this.lang ? 2 : 0) + (v.default ? 1 : 0);
    this.voice = all.sort((a, b) => score(b) - score(a))[0] ?? null;
    this.changed();
  }
  get label(): string {
    if (!("speechSynthesis" in window)) return "sin voz en este navegador";
    if (!this.voice) return "voz del navegador";
    return `${this.voice.name}${this.voice.localService ? "" : " · en la nube"}`;
  }
  get speaking(): boolean {
    return this.pending > 0;
  }
  /** More of Claude's text: every whole sentence is spoken now. */
  feed(text: string): void {
    this.buf += text;
    for (;;) {
      const m = /^([\s\S]*?[.!?…:;])(\s+)/.exec(this.buf);
      if (!m) break;
      this.say(m[1]!);
      this.buf = this.buf.slice(m[0].length);
    }
  }
  /** The turn ended: what is left is spoken. */
  flush(): void {
    this.say(this.buf);
    this.buf = "";
  }
  say(text: string): void {
    const t = text.trim();
    if (!t || !this.on || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(t);
    u.lang = this.voice?.lang ?? this.lang;
    if (this.voice) u.voice = this.voice;
    this.pending += 1;
    this.changed();
    const done = () => {
      this.pending = Math.max(0, this.pending - 1);
      this.changed();
    };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  }
  /** Silence at once: the person speaks, or a stop. */
  cancel(): void {
    this.buf = "";
    this.pending = 0;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.changed();
  }
}

// ---------------------------------------------------------------- the panel

export interface ChatHost {
  /** Sends one message to the process; false when the socket is closed. */
  send(m: ChatPageMessage): boolean;
  toast(text: string, kind?: "error" | "info"): void;
  /** The voice the page's speaker phrases use too: the robot has one voice. */
  setVoice(v: SpeechSynthesisVoice | null): void;
}

export class ChatPanel {
  private root: HTMLElement | null = null;
  private status: ChatStatus | null = null;
  private online = true;
  private listening = false;
  private ear = new Ear("es-ES");
  private voice: Voice;
  /** The text element of each turn's answer. */
  private answers = new Map<number, HTMLElement>();
  /** The row of each call, by its number. */
  private callRows = new Map<number, HTMLElement>();
  /** Whether the answer of this turn is spoken (a live turn, not one from the history). */
  private live = new Set<number>();
  private cloudAgreed = false;
  /** The tool running now, in the person's words, for the state pill. */
  private tool: string | null = null;

  constructor(private readonly host: ChatHost) {
    this.voice = new Voice("es-ES", () => this.voiceChanged());
  }

  /** The process said hello: build the panel when the chat is on, remove it when it is not. */
  hello(chat: { status: ChatStatus; history: ChatServerMessage[] } | undefined): void {
    if (!chat) return this.remove();
    this.build();
    this.list().replaceChildren();
    this.answers.clear();
    this.callRows.clear();
    this.status = chat.status;
    for (const m of chat.history) this.receive(m, false);
    this.render();
  }

  receive(m: ChatServerMessage, live = true): void {
    if (!this.root) return;
    switch (m.t) {
      case "chat":
        this.status = m;
        if (m.state === "off") this.note("off", `${OFF[m.off?.code ?? ""] ?? m.off?.why ?? ""}`, m.off?.why);
        break;
      case "chat_user":
        this.row("user", `<span class="via">${m.via === "voice" ? "🎙" : "⌨"}</span>${esc(m.text)}`);
        if (live) this.live.add(m.turn);
        break;
      case "chat_delta": {
        let el = this.answers.get(m.turn);
        if (!el) {
          el = this.row("robot", `<b class="who">${esc(this.status?.robot.name ?? "")}</b><span class="say"></span>`);
          this.answers.set(m.turn, el);
        }
        const list = this.list();
        const near = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
        el.querySelector(".say")!.textContent += m.text;
        if (near) list.scrollTop = list.scrollHeight;
        if (live && this.live.has(m.turn)) this.voice.feed(m.text);
        break;
      }
      case "chat_end":
        if (live && this.live.has(m.turn)) {
          if (!m.stopped) this.voice.flush();
          this.live.delete(m.turn);
        }
        if (!m.ok && !m.stopped) this.note("error", `No pude terminar: ${m.error ?? "error"}`);
        this.row("cost", `${(m.cost_usd * 100).toFixed(2)} ¢ · ${(m.ms / 1000).toFixed(1)} s`);
        break;
      case "chat_stopped":
        this.voice.cancel();
        this.row(
          "stopped",
          `■ Parado en ${m.ms} ms${m.robots.every((r) => r.motors_stopped) ? "" : " · no se pudo verificar"}`,
        );
        break;
      case "chat_refused":
        this.host.toast(REFUSED[m.code] ?? m.error);
        break;
    }
    this.render();
  }

  /** A tool call began or ended: it goes in the timeline, where the person sees what the robot did. */
  call(m: CallStart | CallEnd): void {
    if (!this.root || m.tool === "list_robots" || m.tool === "describe_robot") return;
    const word = (TOOL[m.tool] ?? ["⚙", m.tool])[1];
    let row = this.callRows.get(m.n);
    this.tool = m.t === "call_start" ? word : null;
    if (m.t === "call_start") {
      row = this.row(
        "call busy",
        `${glance(m.tool, m.args)}<span class="st">…</span><span class="more" hidden></span>`,
      );
      row.title = `${m.tool} ${m.args}`;
      // one click shows the whole call, as in the activity list
      const r = row;
      r.addEventListener("click", () => {
        const more = r.querySelector<HTMLElement>(".more")!;
        more.textContent = r.title;
        more.hidden = !more.hidden;
      });
      this.callRows.set(m.n, row);
    } else if (row) {
      row.classList.remove("busy");
      // a move that "succeeded" but did not do all it was asked says why (stopped, blocked, cut, a condition)
      const why = /\breason=(preempted|stalled|timeout|clamped|condition_met)\b/.exec(m.summary)?.[1];
      row.classList.add(!m.ok ? "err" : why && why !== "condition_met" ? "warn" : "ok");
      row.querySelector(".st")!.textContent = !m.ok
        ? `✕ ${m.code ?? ""}`
        : `${why ? `${REASON[why]} · ` : "✓ "}${(m.ms / 1000).toFixed(1)} s`;
      row.title = `${row.title}\n${m.summary}`;
    }
    this.render();
  }

  linkState(open: boolean): void {
    this.online = open;
    if (!open) this.stopListening(true);
    this.render();
  }

  /**
   * For a test of the whole voice path without a microphone: plays the audio file at `url` into the same
   * recognizer the talk button uses, then sends what it heard. Resolves with the text it heard.
   */
  async sayFile(url: string): Promise<string> {
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    const track = dest.stream.getAudioTracks()[0]!;
    this.startListening(track);
    src.start();
    await new Promise((r) => (src.onended = r));
    const text = await this.finishListening();
    await ctx.close();
    return text;
  }

  // ---------------------------------------------------------------- listening

  private startListening(track?: MediaStreamTrack): void {
    if (this.listening || !this.canTalk()) return;
    // the person speaks: the robot is silent (barge-in)
    this.voice.cancel();
    if (this.ear.where === "none")
      return this.host.toast("Este navegador no reconoce voz: usa Chrome o Edge, o escribe");
    if (this.ear.where !== "local" && !this.cloudAgreed && !track) {
      this.cloudAgreed = true;
      return this.host.toast(
        `Tu voz se convertirá en texto en el servicio de ${this.ear.where === "google" ? "Google" : "Microsoft"}. Mantén otra vez para hablar.`,
        "info",
      );
    }
    this.listening = true;
    this.stoppedWhileListening = false;
    this.heard("");
    this.ear.start({
      ...(track ? { track } : {}),
      onText: (t) => {
        this.heard(t);
        // a spoken "para" stops the robot while the person still speaks, before they let go. Listening goes on:
        // "para qué sirve…" begins with it, and the rest of the question is sent at the release.
        if (!this.stoppedWhileListening && isStopUtterance(t)) {
          this.stoppedWhileListening = true;
          this.stop(false);
        }
      },
      onError: (code) => {
        this.stopListening(true);
        this.host.toast(
          code === "not-allowed"
            ? "El navegador no deja usar el micrófono: permítelo en el candado de la barra de direcciones"
            : code === "language-not-supported"
              ? "Este navegador no reconoce este idioma"
              : `No pude escuchar (${code})`,
        );
      },
    });
    this.render();
  }

  private async finishListening(): Promise<string> {
    if (!this.listening) return "";
    this.listening = false;
    this.render();
    const text = await this.ear.finish();
    this.heard("");
    await this.afterHearing(text);
    return text;
  }

  /**
   * What the recognizer heard, once the person let go: a stop when it is only a stop word (unless that stop was
   * already sent while they spoke), else a message, sent once a stopped turn has ended.
   */
  private async afterHearing(text: string): Promise<void> {
    if (!text) return;
    if (isStopUtterance(text)) {
      if (!this.stoppedWhileListening) this.stop();
      return;
    }
    for (let i = 0; i < 50 && this.status?.state !== "idle" && this.status?.state !== "off"; i++)
      await new Promise((r) => setTimeout(r, 100));
    this.sendText(text, "voice");
  }
  private stoppedWhileListening = false;

  private stopListening(abort: boolean): void {
    if (!this.listening) return;
    this.listening = false;
    if (abort) this.ear.abort();
    this.heard("");
  }

  // ---------------------------------------------------------------- sending

  private canTalk(): boolean {
    return this.online && this.status !== null && this.status.state !== "off";
  }

  private sendText(raw: string, via: ChatVia): void {
    const text = raw.trim().slice(0, CHAT_TEXT_MAX);
    if (!text) return;
    if (isStopUtterance(text)) return this.stop();
    this.voice.cancel();
    if (!this.host.send({ t: "chat_send", text, via })) this.host.toast("Sin conexión con spinecord: no se envió");
  }

  /** Stop: the process stops the robot; this page silences itself at once, without waiting for the answer. */
  private stop(endListening = true): void {
    this.voice.cancel();
    if (endListening) this.stopListening(true);
    if (!this.host.send({ t: "chat_stop" })) this.host.toast("Sin conexión con spinecord: no se pudo parar");
  }

  // ---------------------------------------------------------------- the DOM

  private build(): void {
    if (this.root) return;
    const style = document.createElement("style");
    style.id = "chat-css";
    style.textContent = css;
    document.head.append(style);
    const root = document.createElement("section");
    root.id = "chat";
    root.className = "chat panel";
    root.setAttribute("aria-label", "Chat con el robot");
    root.innerHTML = `
      <header class="chat-head">
        <span class="avatar" aria-hidden="true"></span>
        <b class="name"></b>
        <span class="pill" role="status"></span>
        <span class="spacer"></span>
        <span class="spend" title=""><i></i></span><span class="spent mono"></span>
        <button class="voice-btn icon" aria-pressed="true" title="">🔊</button>
        <button class="lang" title="Idioma de la voz">ES</button>
      </header>
      <div class="chat-body">
        <ol class="timeline" aria-live="polite"></ol>
        <div class="controls">
          <button class="talk" aria-label="Mantén pulsado para hablar (barra espaciadora)"><span class="mic">🎙</span></button>
          <span class="where"></span>
          <button class="stop" aria-label="Parar el robot (P)">■ Parar</button>
        </div>
      </div>
      <div class="heard" hidden></div>
      <form class="say-row">
        <input class="text" maxlength="${CHAT_TEXT_MAX}" autocomplete="off" placeholder="Escribe, o mantén ␣ para hablar" aria-label="Mensaje para el robot" />
        <button class="send" aria-label="Enviar">➤</button>
      </form>`;
    document.body.append(root);
    document.body.classList.add("chat-on");
    this.root = root;

    const talk = root.querySelector<HTMLButtonElement>(".talk")!;
    const release = () => void this.finishListening();
    talk.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      talk.setPointerCapture(e.pointerId);
      this.startListening();
    });
    talk.addEventListener("pointerup", release);
    talk.addEventListener("pointercancel", release);
    talk.addEventListener("contextmenu", (e) => e.preventDefault());
    root.querySelector(".stop")!.addEventListener("click", () => this.stop());
    root.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = root.querySelector<HTMLInputElement>(".text")!;
      this.sendText(input.value, "typed");
      input.value = "";
    });
    root.querySelector<HTMLInputElement>(".text")!.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.stop();
      }
    });
    root.querySelector(".voice-btn")!.addEventListener("click", () => {
      this.voice.on = !this.voice.on;
      if (!this.voice.on) this.voice.cancel();
      this.render();
    });
    root.querySelector(".lang")!.addEventListener("click", () => {
      const lang = this.ear.lang === "es-ES" ? "en-US" : "es-ES";
      this.ear.lang = lang;
      this.voice.setLang(lang);
      this.ear.reset();
      this.render();
    });
    root.querySelector(".where")!.addEventListener("click", () => {
      if (this.ear.where === "local" || this.ear.where === "none") return;
      void this.ear.useLocal().then((r) => {
        this.host.toast(
          r === "local"
            ? "Voz local lista: tu voz ya no sale de este computador"
            : "Este navegador no tiene reconocimiento de voz local para este idioma",
          r === "local" ? "info" : "error",
        );
        this.render();
      });
    });
    // hold the space bar to talk, P to stop: anywhere but in a text field
    window.addEventListener("keydown", (e) => {
      if (!this.root || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      if (e.key === " " && !(t instanceof HTMLButtonElement && t !== talk)) {
        e.preventDefault();
        if (!e.repeat) this.startListening();
      } else if (e.key.toLowerCase() === "p") {
        e.preventDefault();
        this.stop();
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === " " && this.listening) {
        e.preventDefault();
        release();
      }
    });
    this.ear.reset();
    (window as unknown as { spinecordChat?: unknown }).spinecordChat = {
      sayFile: (url: string) => this.sayFile(url),
      ear: () => ({ where: this.ear.where, lang: this.ear.lang }),
      /** The step after the recognizer, for a test whose browser has no recognizer: as if `text` was heard. */
      heard: (text: string) => this.afterHearing(text),
      voice: () => this.voice.label,
    };
  }

  private remove(): void {
    this.root?.remove();
    document.getElementById("chat-css")?.remove();
    document.body.classList.remove("chat-on");
    this.root = null;
  }

  private list(): HTMLOListElement {
    return this.root!.querySelector<HTMLOListElement>(".timeline")!;
  }

  private row(kind: string, html: string): HTMLElement {
    const list = this.list();
    const near = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.querySelector(".empty")?.remove();
    const li = document.createElement("li");
    li.className = kind;
    li.innerHTML = html;
    list.append(li);
    while (list.children.length > 200) list.firstElementChild!.remove();
    if (near) list.scrollTop = list.scrollHeight;
    return li;
  }

  private note(kind: "off" | "error", text: string, detail?: string): void {
    const li = this.row(`note ${kind}`, esc(text));
    if (detail) li.title = detail;
  }

  private heard(text: string): void {
    const el = this.root?.querySelector<HTMLElement>(".heard");
    if (!el) return;
    el.hidden = !this.listening && !text;
    el.textContent = text || "…";
  }

  private voiceChanged(): void {
    if (!this.voice) return; // the voice reports its first pick while it is being made
    this.host.setVoice(this.voice.voice);
    this.render();
  }

  private render(): void {
    const r = this.root;
    if (!r || !this.status) return;
    const s = this.status;
    const key = !this.online
      ? "offline"
      : this.listening
        ? "listening"
        : s.state === "idle" && this.voice.speaking
          ? "speaking"
          : s.state;
    const [icon, word, cls] = STATE[key];
    const pill = r.querySelector<HTMLElement>(".pill")!;
    pill.className = `pill ${cls}`;
    pill.textContent = `${icon} ${key === "acting" && this.tool ? this.tool : word}`;
    r.dataset.state = key;
    r.querySelector(".name")!.textContent = s.robot.name;
    const spend = r.querySelector<HTMLElement>(".spend")!;
    spend.querySelector("i")!.style.width = `${Math.min(100, (100 * s.spent_usd) / s.budget_usd).toFixed(1)}%`;
    r.querySelector(".spent")!.textContent = `${(s.spent_usd * 100).toFixed(1)} ¢`;
    spend.title = `Gastado $${s.spent_usd.toFixed(4)} de $${s.budget_usd.toFixed(2)} · ${s.model}${s.paid_by ? ` · ${s.paid_by}` : ""}`;
    const vb = r.querySelector<HTMLButtonElement>(".voice-btn")!;
    vb.textContent = this.voice.on ? "🔊" : "🔇";
    vb.setAttribute("aria-pressed", String(this.voice.on));
    vb.title = `Voz del robot: ${this.voice.label}`;
    r.querySelector(".lang")!.textContent = this.ear.lang.slice(0, 2).toUpperCase();
    const talkable = this.canTalk();
    const talk = r.querySelector<HTMLButtonElement>(".talk")!;
    talk.disabled = !talkable || this.ear.where === "none";
    talk.classList.toggle("on", this.listening);
    const where = r.querySelector<HTMLElement>(".where")!;
    where.textContent =
      this.ear.where === "local"
        ? "🔒 voz local"
        : this.ear.where === "none"
          ? "sin voz"
          : `voz → ${this.ear.where === "google" ? "Google" : "Microsoft"}`;
    where.title =
      this.ear.where === "local"
        ? "Tu voz se reconoce en este computador: no sale de aquí"
        : this.ear.where === "none"
          ? "Este navegador no reconoce voz: usa Chrome o Edge"
          : `Mientras mantienes el botón, tu voz va al servicio de ${this.ear.where === "google" ? "Google" : "Microsoft"} para convertirla en texto. Clic: usar el reconocimiento de este computador si el navegador lo tiene (puede descargar unos 60 MB)`;
    where.classList.toggle("cloud", this.ear.where === "google" || this.ear.where === "microsoft");
    const input = r.querySelector<HTMLInputElement>(".text")!;
    input.disabled = !talkable;
    r.querySelector<HTMLButtonElement>(".send")!.disabled = !talkable;
    r.querySelector<HTMLButtonElement>(".stop")!.disabled = !this.online;
    // before the first word: three things to try
    const list = this.list();
    if (list.children.length === 0 && s.state !== "off") {
      const li = document.createElement("li");
      li.className = "empty";
      li.innerHTML = `<span class="hello">Háblame o escríbeme. Prueba:</span>`;
      for (const text of SUGGESTIONS) {
        const b = document.createElement("button");
        b.className = "chip-s";
        b.textContent = text;
        b.disabled = !talkable;
        b.addEventListener("click", () => this.sendText(text, "typed"));
        li.append(b);
      }
      list.append(li);
    } else for (const b of list.querySelectorAll<HTMLButtonElement>(".empty button")) b.disabled = !talkable;
  }
}
