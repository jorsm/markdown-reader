---
id: "0002"
title: Reader
description: The read-along panel for Markdown files (click a sentence, hear it from there, highlighted), its text pipeline, Inworld TTS with language and voice selection, audio cache, local telemetry and spend tracking.
status: accepted
date: 2026-10-21
supersedes: none
code:
    - src/
    - media/
    - scripts/tts-bench.mjs
    - package.json
---

# 0002 — Reader

## Goal

Open any Markdown file in a reading panel next to the editor, click a sentence, and hear the document read aloud from there, verbatim, in a steady audiobook voice, with the current sentence highlighted. Speed goes up to 2.5× without stalls, and one key jumps to the source line to edit it. The point is to re-read long specs fast and stop exactly where something needs changing.

## Context

- Specs are long. Spec 0001 of `vertex-ai-models-chat-provider` is 22,627 characters: about 25 minutes of speech at 1×, 10 at 2.5×. Most of it needs following, not studying; listening while following the text is faster than reading and keeps attention on each sentence.
- An earlier read-along prototype (a separate project for EPUB books) proved the interaction: sentence spans, click to start, highlight while playing. It also showed the failure that matters most: it starts slowly and stalls when the speed goes up. Each sentence there goes through an LLM cleanup call, a Gemini TTS call and a transcode, one after the other, and only the next 2–3 sentences are prepared, one at a time. At 2× a 4-second sentence plays in 2 seconds but takes 3–5 to produce.
- So the design is driven by the **worst case**: the p95 time to produce a sentence against how long it plays at 2.5×, not the average latency.
- TTS models were compared on 21 Oct 2026 (Artificial Analysis leaderboard, vendor docs and price pages). Prices and latencies conflict across sources; see Considered options. Inworld, the chosen engine, was then measured from the owner's machine in Italy (Probe results).

## Non-goals

- Summarizing, paraphrasing or "performing" the text. The reader says what is written.
- Editing inside the panel. Edits happen in the normal editor.
- Offline or local TTS engines (CPU latency of small open models is too high; see Considered options).
- Several voices in one document, voice cloning or voice design.
- Word-level highlighting. Inworld can return word timestamps (`timestampType: WORD`); a later spec can use them.
- Publishing to the Marketplace.

## Considered options

### Where the reader lives

| Option                                                                         | Pros                                                                                                                         | Cons                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Script injected into the built-in Markdown preview (`markdown.previewScripts`) | Same view the owner already uses                                                                                             | The preview's messages go to the built-in Markdown extension, not to ours; its content security policy blocks loading audio from a local server. Not tested here: taken from the preview's documented behavior |
| **Own webview panel, opened by a button in the editor title bar** (chosen)     | Full control of rendering, audio and messages; renders Markdown with the same engine as the built-in preview (`markdown-it`) | Rendering differs slightly from the built-in preview (no other extensions' preview plugins)                                                                                                                    |
| Highlight sentences in the text editor itself                                  | No second view                                                                                                               | Raw Markdown is harder to follow than rendered text                                                                                                                                                            |

### TTS engine

Only pay-as-you-go pricing is acceptable; subscription plans (ElevenLabs, Cartesia) are excluded. Costs are per 1M characters at list price after promotions end; "Read 0001" is one full listen of the 22.6k-character spec above, cache empty.

| Engine                             | Price /1M chars | Read 0001 | Latency (third-party, not measured here)      | Pause and emphasis control                            | Notes                                                                                                 |
| ---------------------------------- | --------------- | --------- | --------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Speechify Simba 3.2                | 10              | ~0.23 $   | 123 ms to first audio                         | SSML `<break>`, `<prosody>`, `<emphasis>`, `<sub>`    | Separate account and API key                                                                          |
| **Inworld TTS-2 Flash** (chosen)   | 15 (TTS-2: 25)  | ~0.34 $   | measured: 158–180 ms to first audio           | SSML `<break>` (20 per request)                       | Separate account and API key; 15 tier-1 languages, Italian included                                   |
| OpenAI gpt-4o-mini-tts             | ~17             | ~0.38 $   | not published                                 | Natural-language `instructions`; no break tags        | Lowest quality of the four on blind votes; a secondary source reports a retirement date of 6 Jan 2027 |
| Gemini 3.8 Flash-Lite TTS (Vertex) | ~20             | ~0.45 $   | about 1 s to first token (gateway figures)    | `<short pause>`, `<long pause>`, short `style` string | ADC and GCP billing, no new account; preview, `global` only                                           |
| Gemini 3.8 Flash TTS (Vertex)      | ~30             | ~0.68 $   | not measured                                  | as Flash-Lite                                         | Best quality of the Gemini models                                                                     |
| Kokoro 82M (local)                 | 0               | 0         | ~3.7 s to first audio on CPU in one benchmark | none                                                  | Rejected: latency                                                                                     |

Cost does not decide: every candidate costs under a dollar per spec, and re-listening is served from the cache. Inworld was chosen by the owner after the research above; the probe below confirmed the latency, and D3 measures the worst case.

#### Probe results (21 Oct 2026)

16 streaming requests to `https://api.inworld.ai/tts/v1/voice:stream` from Italy, MP3 at 24 kHz, `applyTextNormalization: OFF`, sentences of 31–179 characters taken from specs. "Real-time factor" is audio duration divided by total request time; playback at 2.5× needs more than 2.5 per unit in flight.

| Model                 | Voice, language | First audio             | Total        | Audio      | Lowest real-time factor |
| --------------------- | --------------- | ----------------------- | ------------ | ---------- | ----------------------- |
| `inworld-tts-2-flash` | Elliot, en      | 469 ms cold, 158–166 ms | 329–1,013 ms | 2.9–14.3 s | 6.9 (cold), then 8.9    |
| `inworld-tts-2-flash` | Beatrice, en    | 159–180 ms              | 290–879 ms   | 2.4–11.6 s | 8.1                     |
| `inworld-tts-2-flash` | Orietta, it     | 159–162 ms              | 479–524 ms   | 5.3–5.9 s  | 11.1                    |
| `inworld-tts-2`       | Elliot, en      | 487 ms cold, 198–213 ms | 601–2,283 ms | 3.1–14.0 s | 4.3                     |
| `inworld-tts-2`       | Orietta, it     | 192–237 ms              | 852–882 ms   | 4.9–5.4 s  | 5.7                     |

The first request pays the TLS handshake (~300 ms), so connections are kept alive. The default US endpoint is used: Inworld's EU region (`api.eu.inworld.ai`) is a separate deployment sold only through enterprise contracts, with its own workspaces and keys, so a self-serve key is unknown there (403, "API key does not exist"). 16 requests give no p95: that is D3's job.

### Where audio plays

The draft (PR "draft reader") showed two limits of VS Code's webview, both measured in VS Code 1.142 (snap) on Linux:

- It cannot decode Opus: WebAudio fails on a valid Ogg Opus file while MP3, WAV, FLAC and Vorbis decode, although `canPlayType` answers "probably". Hence MP3.
- In the snap build it has no sound at all: the snap ships only ALSA (`libasound`), so the audio element advances in silence and PipeWire shows no stream.

| Option                                                                | Pros                                                                                                                   | Cons                                                                                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Audio element in the webview                                          | No dependency; speed with pitch kept (`preservesPitch`)                                                                | Silent in the snap build; codec support varies by build                                                              |
| **ffplay (FFmpeg) run by the extension host** (chosen when available) | Talks to the system's audio server directly; `atempo` keeps the pitch; same approach as other VS Code audio extensions | Needs FFmpeg installed; a speed change applies from the next unit; pause relies on SIGSTOP/SIGCONT (Linux and macOS) |

### Text processing

| Option                                                               | Pros                               | Cons                                          |
| -------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------- |
| **Deterministic rules** (chosen first)                               | No added latency or cost, testable | May read code, paths and tables badly         |
| An LLM (e.g. Gemini 3 Flash) rewriting each section into spoken form | Handles anything                   | Adds about a second per call, can alter words |

Rules come first, behind an interface an LLM processor can replace without touching the panel, the player or the engines (see Behavior).

## Decisions

Made by the owner on 21 Oct 2026:

- A VS Code extension in its own repo, built through the spec workflow of spec 0001.
- Verbatim, steady narration: the text is not reworded and not acted. Pauses and emphasis come from structure and punctuation.
- Pay-as-you-go engines only, no subscriptions.
- Latency is judged on the worst case (p95 and stalls), not the average.
- Deterministic text rules first, structured so an LLM processor can replace them.
- Minimal local telemetry from the first deliverable.
- Spend is tracked locally, from the characters Inworld reports as processed, so the owner can see what reading costs without opening the Inworld portal.
- Engine: Inworld. Default model `inworld-tts-2-flash` (fastest and cheapest; its lack of steering does not matter for verbatim narration); `inworld-tts-2` is selectable. D3 confirms the default on the worst case.
- Language and voice are chosen in the panel.

## Behavior and invariants

### Panel

- A button in the editor title bar for Markdown files, and the command **Markdown Reader: Open Reader**, open the panel beside the editor for the active file.
- The panel renders the file with `markdown-it`. YAML frontmatter is not shown or read.
- A toolbar at the top of the panel has a **language** selector (Inworld's 15 tier-1 languages, English first) and a **voice** selector listing the voices whose original language matches, with their description as tooltip. The language and voice are remembered per document, falling back to the last ones used; the first defaults are English with Elliot and Italian with Orietta. Changing either stops playback and empties the prepared units, not the cache.
- Every **speech unit** is a clickable span: a sentence in a paragraph or list item, a heading, a table row. Code blocks are units that are skipped, not read (see Open questions).
- Clicking a unit plays from it. The playing unit is highlighted and kept in view.
- Keys in the panel: Space play/pause; ← → previous/next unit; `+`/`-` speed in 0.25 steps from 1× to 2.5×; `E` reveals the playing unit's source line in the editor. Double-click on a unit also reveals its line.
- On save, the panel re-renders. Playback continues from the same unit if it still exists, otherwise it pauses at the nearest following unit.

### Text pipeline

- **Units** carry an id, a kind (sentence, heading, list sentence, table row, code), the source line range and the source text. The id is a hash of kind and text plus an occurrence counter, so editing one sentence leaves the other ids unchanged.
- A **`TextProcessor`** turns units into **spoken units**: an engine-neutral list of segments (`text`, `pause` with milliseconds, `emphasis`). It never sees engine markup. The deterministic processor:
    - speaks inline code by rules: `src/utils/retry.ts` as "src slash utils slash retry dot ts", `camelCase` split into words, `B11` as "B 11". The symbol words come from a table per language (English and Italian at first; other languages use English);
    - speaks link text only, never URLs;
    - marks bold text as `emphasis`;
    - reads a table's header row once, then each row with a short pause between cells. No words are added.
- **Verbatim guard:** every processor's output must contain the source words of the unit, in order, apart from the documented code rules. A processor whose output fails the guard for a unit falls back to the deterministic one for that unit, and the failure is logged (metadata only). This is what lets an LLM processor be swapped in safely.
- Each **engine adapter** renders segments into its own markup and returns audio. The Inworld adapter:
    - streams from `POST /tts/v1/voice:stream` with `modelId`, `voiceId`, `language` and MP3 output, reading the NDJSON lines and treating an in-stream `error` as a failed request. Never Ogg Opus: VS Code's webview can't decode it;
    - renders `pause` as `<break time="…ms" />`, at most 20 per request (Inworld ignores the rest); `emphasis` becomes plain text, since Flash has no emphasis control;
    - sends the preceding units of the same section, at most 5 units and 2,000 characters (Inworld rejects more with a 400), as `synthesisContext.previousRequests`, which Inworld uses for intonation and does not bill or speak. D3 checks that it helps;
    - keeps the HTTP connection alive between requests.
- Voices come from Inworld's voice list (`GET /tts/v1/voices`, or its replacement in the Voice API if equivalent), cached for a day.
- **Pauses between units** are silence inserted by the player, by unit kind (heading longest, table row shortest), divided by the speed. They are the same for every engine.

### Audio and scheduling

- One synthesis request per unit. Audio is cached on disk in the extension's global storage, keyed by a hash of engine, model, voice, language, processor id and version, and spoken segments. Re-listening never calls the engine; editing a sentence re-synthesizes only that unit.
- From the playing unit, the next N units (default 6) are prepared with up to C requests in flight (default 3). A click elsewhere cancels in-flight requests outside the new window.
- Speed is applied by the player with pitch preserved. Changing speed never re-synthesizes.
- **Audio output** (setting `markdownReader.audioOutput`): `auto` (default) plays through ffplay when it runs on the machine and falls back to the webview's audio element; `ffplay` and `webview` force one. With ffplay the extension host sequences the units (play, inserted pause, next) and the panel only highlights and sends commands; a speed change applies from the next unit. A "Markdown Reader" output channel logs which output is in use and, when ffplay is unusable, why.
- The Inworld key is kept in `SecretStorage` (command **Markdown Reader: Set API Key**). It stays in the extension host: the webview never sees it, and it is never written to settings, logs or telemetry.
- **The key is validated when it is entered**, before it is stored, with a call that synthesizes nothing and bills nothing (the voice list):
    - accepted (200): stored, and the open panels reload their voice list;
    - rejected (401 or 403): not stored; the error says Inworld rejected the key and offers to enter it again. The previously stored key, if any, stays;
    - not checkable (network error, timeout, 5xx): stored, with a warning that it could not be verified. A wrong key then shows up at the first request.
- Before the call, the input is trimmed and checked to be Base64 that decodes to `key:secret`, the shape of the portal's Basic credential; anything else is refused without calling Inworld.
- A request that fails later with 401 or 403 (key revoked or deleted) pauses playback and offers to enter a new key; it is not retried.
- The text of the file goes to the chosen engine's provider and nowhere else.

### Telemetry

- Local only: JSON Lines files in the extension's global storage, one per day, deleted after 30 days. Nothing is sent anywhere.
- Events carry metadata only, never document text: `synth` (engine, model, voice, language, characters sent, characters billed, estimated cost, cache hit, time to first byte, total time, audio duration, error code), `play_start` (click to first sound), `stall` (wait time, speed, units ready), `session_end` (units played, speed, stall count).
- **Markdown Reader: Show Telemetry Summary** prints p50 and p95 per engine and the stall count per session in an output channel.

### Spend

- **Characters billed** are Inworld's own count: `result.usage.processedCharactersCount` in the first message of each stream. Inworld bills characters as sent, tags included; `synthesisContext` is not billed. A cache hit bills nothing.
- **Estimated cost** is characters billed times the model's rate per million characters, from the setting `markdownReader.pricePerMillionCharacters`. Its default is the on-demand list price on 21 Oct 2026: `inworld-tts-2-flash` 15 $, `inworld-tts-2` 25 $. Inworld's prices change and higher plans pay less, so the setting is the place to correct them; the figure is an estimate, and the Inworld portal's usage page remains the authority.
- A **spend ledger** keeps one total per day and model (characters billed, estimated cost, requests, cache hits) in the extension's global storage. Unlike the raw events it is never deleted, so month and all-time totals survive the 30-day telemetry retention.
- The panel toolbar shows the estimated spend of the current session and of the current month. The summary command adds spend per day for the last 30 days, per month, per model, and per document (by workspace-relative path; the path is metadata, the content is not recorded).

## Deliverables

- [ ] D1. Telemetry writer, retention, the event schema above and the spend ledger, with a test that a document's text never reaches the files.
- [ ] D2. Markdown to units, the segment format, the `TextProcessor` interface, the deterministic processor and the verbatim guard, tested on real specs.
- [ ] D3. `scripts/tts-bench.mjs` and its results: see below.
- [ ] D4. The Inworld adapter, the voice list, the key command and the audio cache.
- [ ] D5. The panel and player: rendering, language and voice selectors, the spend display, click to play, highlight, keys, jump to source, re-render on save, scheduling, inserted pauses, `stall` and `play_start` events.
- [ ] D6. The telemetry and spend summary command and a local `.vsix` build.

### D3. Inworld benchmark

- [ ] Delivered

- Run by hand from the owner's machine, with the key from the `INWORLD_API_KEY` environment variable. Compares `inworld-tts-2-flash` and `inworld-tts-2`, in English and Italian, with and without `synthesisContext`, and with text normalization on and off.
- Input: the first 40 units of a given Markdown file, through the D2 pipeline and the D4 adapter's request builder.
- Measures per request: time to first byte (streaming where the engine offers it), total time, audio duration. Runs once sequentially and once with 3 requests in flight.
- Simulates playback at 1×, 2× and 2.5× with N=6 and C=3 from the measured times, and counts stalls.
- Writes measurements as telemetry `synth` events and audio samples to a directory outside the repo, for listening side by side, and prints the characters billed and estimated cost of the run.
- The branch that delivers D3 adds a `## Benchmark results` section to this spec (p50/p95 per variant, stalls per speed, characters billed) and records the default model and the `synthesisContext` and normalization settings under Decisions.

## Acceptance checks

- Telemetry files written while reading a test document that contains a unique marker string never contain that string. Catches document text leaking into telemetry or logs.
- For every unit of the specs in `vertex-ai-models-chat-provider` and in this repo, the deterministic processor's output passes the verbatim guard. Catches rules that drop or reorder words.
- A processor that returns altered words for a unit is replaced by the deterministic output for that unit, and a log line records it. Catches a guard that only logs.
- Editing one sentence and saving re-synthesizes exactly one unit (telemetry: one `synth` with `cacheHit: false`). Catches unit ids that shift after an edit.
- Reading spec 0001 of `vertex-ai-models-chat-provider` from the first unit to the end at 2.5×, cache empty, records zero `stall` events after the first unit. Catches scheduling that keeps up on average but not in the worst case.
- A day's characters billed in the spend ledger equal the characters Inworld's portal reports for that day, checked once by hand after D5. Catches counting characters sent instead of characters billed, or missing failed-but-billed requests.
- Replaying a fully cached document adds no characters billed and no cost to the ledger. Catches cache hits counted as spend.
- Click to first sound: p95 at most 1 s with the cache empty, at most 200 ms with the cache warm (telemetry `play_start`). Catches a slow start.
- Changing speed during playback makes no `synth` request. Catches speed applied by the engine instead of the player.
- Switching the voice and back plays the earlier units from the cache (`cacheHit: true`). Catches a cache key that ignores the voice.
- The Inworld key appears in no file under the extension's storage, no log line and no message to the webview (search for it after a session). Catches a leaked credential.
- Entering a key Inworld rejects leaves the stored key unchanged and shows the rejection; entering a malformed key makes no request. Catches a wrong key replacing a working one, or a typo reaching Inworld.
- With the network down, entering a key stores it with a warning. Catches a validation that blocks setup offline.

## Open questions

- Should ffplay be bundled for platforms where FFmpeg is rarely installed (Windows), as some audio extensions do, or is a clear message enough?

- Should a monthly budget (e.g. `markdownReader.monthlyBudgetUsd`) warn or stop synthesis when reached, or is seeing the spend enough?
- Latency targets: are 1 s (cold) and 200 ms (warm) for click to first sound the right bar?
- Code blocks: skip silently (current proposal), or read them?
- Should the panel follow the editor's cursor (click in the source to set the start point), or is the button-plus-click flow enough for now?
