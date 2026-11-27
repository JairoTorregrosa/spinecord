# Talking to the robot in the 3D view (`--chat`, experimental)

The 3D view can hold a chat with Claude: the person types or holds a button and speaks, the robot answers in text and in its voice, and moves while they watch, in one window. The contract is CONTRACT.md §6, "Chat in the 3D view"; the code is `apps/local/src/chat.ts` (the process) and `apps/twin-view/src/chat.ts` (the page). Without `--chat` nothing of it loads or shows.

```sh
ANTHROPIC_PROFILE=credits bun apps/local/main.ts --twin deployments/<name>/robots/<robot>.json --view --chat
```

Open the address it prints (`http://127.0.0.1:8769/`) in Chrome or Edge. `--chat-model <id>` (default `claude-haiku-5-5`) and `--chat-usd <n>` (default 1) are the model and the budget of the process. When this process is the MCP server of a Claude Code, the flag goes in the registered command, and Claude Code's environment (its `ANTHROPIC_PROFILE`) is the chat's.

## The design in five lines

1. **Agent loop**: the spinecord process hosts it on the Claude Agent SDK, with its own MCP server attached in-process (`{type: "sdk", instance: buildServer(...)}`): same tools, checks, call log and robot state machines as a Claude Code on stdio, so the two share the robot safely (`busy`). The participant's login pays through the SDK's Claude Code; spinecord never sees a key.
2. **Speech to text**: the browser's own recognizer (Chrome, Edge), hold-to-talk, Spanish by default. It sends the audio to Google or Microsoft unless the person clicks "voz → …" and the browser has on-device recognition for the language; the page says which, always. A better local option (Parakeet v3 in a helper process) is the follow-up, not tomorrow.
3. **Text to speech**: the browser's `speechSynthesis`, a sentence at a time as Claude's text streams, a voice of the computer preferred and named. One voice: the robot talks, as the robot, under its name; the speaker phrases of the twin use the same voice. Holding the talk button silences it.
4. **Where the chat sits**: in the slot of the MCP call list (bottom centre), whose calls it shows in its own timeline: one story of what was said and what was done. Big hold-to-talk button, big red stop, state pill, cost meter, three suggestions before the first word.
5. **Stop**: "para" (spoken, while the person still speaks) or the stop button or `P`: the process stops every robot itself, then interrupts Claude; it never waits for the model. Measured: 13–77 ms from the stop to verified motors stopped, while a real turn ran.

## Who pays, what it costs, how fast

Measured on the Jetson (Orin Nano 8 GB, load 12–19 from other work), through `ANTHROPIC_PROFILE=credits` (an `ant auth login` profile): `paid_by` is read from the SDK's `accountInfo()` and shown on the page's cost meter.

| model (effort low) | first tool call | first text | turn | cost of the turn |
|---|---|---|---|---|
| `claude-haiku-5-5`, "Avanza 30 cm y gira a la izquierda" (drive + turn) | 1.13 s | 7.8 s (after both moves) | 8.0 s | $0.0024 |
| `claude-haiku-5-5`, "¿Qué tienes delante?" | 1.2 s | 2.5 s | 3.3 s | $0.0006 |
| `claude-sonnet-5-5`, the same two | 1.24 s / 0.89 s | 8.0 s / 2.7 s | 8.2 s / 2.8 s | $0.042 / $0.0058 |
| `claude-opus-5-5`, the same two | 1.76 s / 1.50 s | 10.5 s / 4.6 s | 10.9 s / 4.8 s | $0.084 / $0.013 |

- The first text of a moving turn comes after the moves (the prompt says act, then say): the person sees the robot move about 1.2 s after their message, and hears the answer when the move ends. The first spoken word follows the first finished sentence of the stream (the page speaks a sentence as soon as it ends); in the headless browser there was no voice to time it (0 voices), so it is not measured.
- Start: the chat's Claude Code answered who pays 2.8–12 s after the process started (cold cache 11.5 s on this board). The chat is `starting` meanwhile, and the view works.
- Haiku 5.5 is the default: the same moves and honest answers as Sonnet and Opus here ("casi 90 grados, con 89,8 medidos por los encoders"), at 15–35 times less cost, and the shortest first tool call. A $1 budget is about 400 Haiku turns.
- Install: the Agent SDK (and its own Claude Code, 325 MB on Linux arm64, 378 MB on a Mac per `examples/assistant/README.md`) lives in its own workspace package, `apps/chat-sdk`, at the version `examples/assistant` uses, so the server's install (`bun install --filter @spinecord/local`, 11 packages, 46 MB) does not download it. `bun install --filter @spinecord/local --filter @spinecord/chat-sdk` adds it (112 packages, 403 MB on a Mac, `bun bench/install.ts`); a plain `bun install` has it too. `--chat` without it ends the start with that command, and `--doctor` with `--chat` says the same.

## Speech to text: candidates

What runs where, with Spanish. "Measured here" is this board, through the real code path where it says so; the rest is from the sources, with the link.

| candidate | where | Spanish quality | speed | download | reach | install | audio leaves? |
|---|---|---|---|---|---|---|---|
| **Web Speech, maker's service** (default) | browser | good (Google / Azure); not measured: headless has no backend (`network`) | streaming partials while you speak | none | Chrome, Edge on macOS and Windows; not Firefox, Safari partly | none | yes, to Google or Microsoft (said on the button) |
| **Web Speech, on-device** (`processLocally`) | browser | es-ES listed for Edge 150 Canary/Dev ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api)); Chrome 139+ reported with es-ES ([explainer](https://github.com/WebAudio/web-speech-api/blob/main/explainers/on-device-speech-recognition.md), [field report](https://github.com/amngy/glossa/issues/47)) | streaming | ~60 MB pack per language ([blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/VNOok2dbmHM)) | Google-branded Chrome; Edge behind a flag | one click | no |
| **Parakeet TDT 0.6B v3** (NVIDIA) | native helper (sherpa-onnx, MLX, Core ML), or browser via WebGPU ([parakeet.js](https://ysdede.github.io/parakeet.js/api/)) | FLEURS es WER 3.45 % ([model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)); here: see below | 70–190× real time on Apple Silicon ([parakeet-mlx](https://pypi.org/project/parakeet-mlx/), [Core ML](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml)); here: see below | 487 MB int8 (sherpa-onnx release) | macOS, Windows, Linux | a helper and a model download | no |
| **Whisper** (faster-whisper / whisper.cpp) | native, or browser (transformers.js) | here: see below | ~3 s for 20 s of audio with small on an Orin Nano ([speaches](https://hub.docker.com/r/cbinckly/speaches)) | 75 MB (base) to 500 MB (small) | everywhere | a helper and a model, or a 150 MB+ web runtime | no |
| Moonshine | native / browser | a Spanish `base-es` is listed under a community license ([README](https://huggingface.co/UsefulSensors/moonshine)) | very fast, English-first | small | everywhere | a helper | no |

**Measured here (Piper-synthesized Spanish: 12 robot commands, 2 voices, es_ES and es_MX; synthetic speech is easier than a person, so these word error rates are optimistic; numbers normalized to digits on both sides):**

| model (int8, CPU, 4 threads) | WER, all 24 clips | es_ES / es_MX | "para" alone heard as | mean time per clip (1–3 s of audio) | RTF | load time | size |
|---|---|---|---|---|---|---|---|
| faster-whisper tiny | 50.7 % | 46 % / 56 % | "¡Beren!", "¡Verdad!" | 8.6 s | 3.8 | 38.5 s | 75 MB |
| faster-whisper base (the model already on this board) | 40.0 % | 39 % / 41 % | "¡Buenos días!", "¡Déjame!" | 15.9 s | 7.0 | 6.8 s | 145 MB |
| **Parakeet TDT 0.6B v3, sherpa-onnx** | **13.6 %** | 10 % / 17 % | "Bana.", "Yeah." | **1.7 s** | **0.73** | 16.6 s | 487 MB archive |
| faster-whisper small | not measured here: `earlyoom` killed it on every try (host memory) | | | | | | 480 MB |

The host had a load of 12–20 from other agents' builds during every run, and `earlyoom` killed each model several times before one run finished. The times are upper bounds, several times slower than an idle Orin Nano. Even so, Parakeet ran faster than real time on the CPU alone, and Whisper did not. The error rates do not depend on load. Parakeet's errors were mostly in the Mexican voice, and it guesses the language by itself: two short clips came back in Portuguese ("Não, ele tá completa") and English ("Yeah"). Whisper can be forced to Spanish; Parakeet cannot. **No model reliably heard a lone "para"**, which is why the stop button, `P` and Esc are the stop that always works, and a spoken "para" is the extra one. The browser's recognizer, with its live partial text, could not be measured here.

Raw runs: one JSON line per clip (`voice`, `ms`, `errors`, `hyp`) from `measure.py`, run in tmux one model at a time; the script (Python, not part of the project), the sentences and the outputs were handed to the parent with this branch, not committed.

**Which models the operator means.** The only speech model already on this Jetson is `Systran/faster-whisper-base` (in its Hugging Face cache since 2026-05-27): Whisper is what this board has used. The description, though ("very fast, recognizes Spanish well, also on macOS"), fits NVIDIA's **Parakeet TDT 0.6B v3** best: an NVIDIA model that runs on a Jetson (NeMo, Riva, sherpa-onnx), multilingual since v3 (25 European languages, Spanish among them), and the engine behind the fast local dictation apps on macOS (parakeet-mlx, FluidAudio Core ML), at tens to hundreds of times real time. Both run on both machines; Parakeet is the one that is both fast and good in Spanish.

**Why the default is still the browser's recognizer.** It needs no install and no download, gives live partial text while the person speaks (so "para" stops the robot before they let go), and is good in Spanish. Its cost is privacy: without on-device recognition the audio goes to the browser's maker, and the page says so beside the button and before the first time. A local recognizer is better for privacy and works offline, but every option needs a helper process or a large download per participant (Parakeet v3: 487 MB).

**The local option, as a follow-up.** A helper process (never inside the robot's server: a native crash must not take the robot down) that the page streams 16 kHz audio to over loopback, running Parakeet v3 int8 with sherpa-onnx: `sherpa-onnx-node` is a 74 KB package plus one prebuilt binary per platform (23 MB Windows x64, 35 MB macOS arm64, 41 MB Linux arm64, no install script), and the model is downloaded at first use with a progress bar and cached. It is opt-in, behind a setting next to the talk button. The panel already takes any audio track (`Ear.start({track})`), so only the recognizer changes.

## Text to speech

| candidate | Spanish | speed | download | reach | text leaves? |
|---|---|---|---|---|---|
| **`speechSynthesis`, a voice of the computer** (chosen) | macOS and Windows ship Spanish system voices (names vary by version and region; not checked here). Plain but clear; `voiceschanged` must be awaited ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/getVoices)) | starts at once, a sentence at a time | none | every browser | no |
| `speechSynthesis`, a network voice | Chrome's Google voices and Edge's Natural voices ([readium notes](https://readium.org/speech/docs/WebSpeech.html)): better | about as fast | none | Chrome, Edge | yes, to the maker: the page prefers a local voice and names the one in use |
| Piper (native) | es_ES, es_MX voices, good | here: RTF ≈ 1.0 at load 18, first sentence 2.7–3.6 s (an idle board is several times faster); 63 MB per voice | 63 MB per voice | a helper | no |
| Kokoro 82M (browser, WebGPU) | Spanish voices exist ([kokoro-js](https://npmjs.com/package/kokoro-js)) | fast with WebGPU | ~90–330 MB | Chrome, Edge with WebGPU | no |

The browser's voice wins for now: nothing to install, it starts speaking the first sentence while Claude still writes the rest, and the person's talk button cuts it at once (barge-in). Not measured here: the headless browser has no voices.

**One voice.** The chat's voice and the robot's voice are one: Claude speaks as the robot, in the first person, under its name (the `name` of `describe_robot` once robot files have one, else the id: `robotName` in `apps/local/src/chat.ts`), and the page speaks the phrases of the twin's `sim.speaker` with the same voice. The persona is one sentence (`persona()`), so an MCP-side prompt can use the same words. The prompt tells Claude that its text is spoken, so it does not also call a speaker command for the same words.

## What was proven, and how

| what | evidence |
|---|---|
| A typed message moves the orugas twin through the real model | screenshots `02-acting-1366.png`, `03-answered-1366.png` (drive 30 cm, turn 90°, answer) |
| "para" stops a running drive at once, without waiting for Claude | screenshot `04-stopped-1366.png` (real model, drive preempted, stopped in 77 ms); tests `'para' stops a drive the chat started…` and `the stop button stops a drive another client started…` |
| A stop passes even when the page is over its rate limit | test `a stop passes even when the page is over its limit of actions` |
| A failing model turn is reported and the chat goes on | test `a failing turn is reported…`; no login, budget and a dead session leave the chat `off` with the reason |
| Without `--chat` nothing changes | test `without --chat`; screenshot `07-without-chat-1366.png`; the page bundle grows by 24 KB (656 → 680 KB) for the panel code that is not run |
| The voice path | WAV → `sayFile` → the same recognizer the button uses, as an audio track: accepted by Chrome 149 (`start(track)`), then `network` (headless has no speech backend). The step after the recognizer was then driven with Parakeet's transcript of the same WAV (`spinecordChat.heard`, `via: "voice"`): the 🎙 message moved the twin and the robot answered (`09-voice-answered-1366.png`; its drive ended `stalled` after 1 s, and it said so) |

Observed, not caused by the chat: under a host load of 17–19 the orugas twin ended two drives `stalled` after about 1006 ms, with no obstacle in the scene, while the same command completed earlier at a lower load. The robot reported the stall plainly. Worth a look in the twin's stall detection under load before a room of laptops runs it.

Model spend of this prototype, as the SDK estimates it: about $0.16, Sonnet and Opus comparisons included (Haiku turns alone: about $0.01).

**Not tested here**: the live microphone; Chrome's and Edge's recognizers (headless has none); spoken output (0 voices in headless); macOS; Windows; a participant's own Console credits (the run used the operator's `credits` profile on this board).
