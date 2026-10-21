---
id: "0002"
title: Reader
description: The read-along panel for Markdown files (click a sentence, hear it from there, highlighted), its text pipeline, TTS engine choice by worst-case benchmark, audio cache and local telemetry.
status: proposed
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
- TTS models were compared on 21 Oct 2026 (Artificial Analysis leaderboard, vendor docs and price pages). Prices and latencies conflict across sources; see Considered options.

## Non-goals

- Summarizing, paraphrasing or "performing" the text. The reader says what is written.
- Editing inside the panel. Edits happen in the normal editor.
- Offline or local TTS engines (CPU latency of small open models is too high; see Considered options).
- Several voices, voice cloning or voice design.
- Publishing to the Marketplace (spec 0001 D7).

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
| Inworld TTS-2 Flash                | 15              | ~0.34 $   | not measured (TTS-2: 169 ms)                  | SSML `<break>` (20 per request)                       | Separate account and API key                                                                          |
| OpenAI gpt-4o-mini-tts             | ~17             | ~0.38 $   | not published                                 | Natural-language `instructions`; no break tags        | Lowest quality of the four on blind votes; a secondary source reports a retirement date of 6 Jan 2027 |
| Gemini 3.8 Flash-Lite TTS (Vertex) | ~20             | ~0.45 $   | about 1 s to first token (gateway figures)    | `<short pause>`, `<long pause>`, short `style` string | ADC and GCP billing, no new account; preview, `global` only                                           |
| Gemini 3.8 Flash TTS (Vertex)      | ~30             | ~0.68 $   | not measured                                  | as Flash-Lite                                         | Best quality of the Gemini models                                                                     |
| Kokoro 82M (local)                 | 0               | 0         | ~3.7 s to first audio on CPU in one benchmark | none                                                  | Rejected: latency                                                                                     |

Cost does not decide: every candidate costs under a dollar per spec, and re-listening is served from the cache. The choice is made by the D3 benchmark on the worst case, then by ear.

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
- The engine is chosen from the D3 benchmark results, recorded in this spec by the branch that delivers D3.

## Behavior and invariants

### Panel

- A button in the editor title bar for Markdown files, and the command **Spec Reader: Open Reader**, open the panel beside the editor for the active file.
- The panel renders the file with `markdown-it`. YAML frontmatter is not shown or read.
- Every **speech unit** is a clickable span: a sentence in a paragraph or list item, a heading, a table row. Code blocks are units that are skipped, not read (see Open questions).
- Clicking a unit plays from it. The playing unit is highlighted and kept in view.
- Keys in the panel: Space play/pause; ← → previous/next unit; `+`/`-` speed in 0.25 steps from 1× to 2.5×; `E` reveals the playing unit's source line in the editor. Double-click on a unit also reveals its line.
- On save, the panel re-renders. Playback continues from the same unit if it still exists, otherwise it pauses at the nearest following unit.

### Text pipeline

- **Units** carry an id, a kind (sentence, heading, list sentence, table row, code), the source line range and the source text. The id is a hash of kind and text plus an occurrence counter, so editing one sentence leaves the other ids unchanged.
- A **`TextProcessor`** turns units into **spoken units**: an engine-neutral list of segments (`text`, `pause` with milliseconds, `emphasis`). It never sees engine markup. The deterministic processor:
    - speaks inline code by rules: `src/utils/retry.ts` as "src slash utils slash retry dot ts", `camelCase` split into words, `B11` as "B 11";
    - speaks link text only, never URLs;
    - marks bold text as `emphasis`;
    - reads a table's header row once, then each row with a short pause between cells. No words are added.
- **Verbatim guard:** every processor's output must contain the source words of the unit, in order, apart from the documented code rules. A processor whose output fails the guard for a unit falls back to the deterministic one for that unit, and the failure is logged (metadata only). This is what lets an LLM processor be swapped in safely.
- Each **engine adapter** renders segments into its own markup (SSML, angle-bracket tags, or plain text with pauses inserted as silence) and returns audio.
- **Pauses between units** are silence inserted by the player, by unit kind (heading longest, table row shortest), divided by the speed. They are the same for every engine.

### Audio and scheduling

- One synthesis request per unit. Audio is cached on disk in the extension's global storage, keyed by a hash of engine, model, voice, processor id and version, and spoken segments. Re-listening never calls the engine; editing a sentence re-synthesizes only that unit.
- From the playing unit, the next N units (default 6) are prepared with up to C requests in flight (default 3). A click elsewhere cancels in-flight requests outside the new window.
- Speed is applied by the player with pitch preserved. Changing speed never re-synthesizes.
- API keys are kept in `SecretStorage` (command **Spec Reader: Set API Key**). If a Vertex engine is chosen, its project comes from a setting only, never from the credential.
- The text of the file goes to the chosen engine's provider and nowhere else.

### Telemetry

- Local only: JSON Lines files in the extension's global storage, one per day, deleted after 30 days. Nothing is sent anywhere.
- Events carry metadata only, never document text: `synth` (engine, model, characters, cache hit, time to first byte, total time, audio duration, error code), `play_start` (click to first sound), `stall` (wait time, speed, units ready), `session_end` (units played, speed, stall count).
- **Spec Reader: Show Telemetry Summary** prints p50 and p95 per engine and the stall count per session in an output channel.

## Deliverables

- [ ] D1. Telemetry writer, retention and the event schema above, with a test that a document's text never reaches the files.
- [ ] D2. Markdown to units, the segment format, the `TextProcessor` interface, the deterministic processor and the verbatim guard, tested on real specs.
- [ ] D3. `scripts/tts-bench.mjs` and its results: see below.
- [ ] D4. The chosen engine's adapter and the audio cache.
- [ ] D5. The panel and player: rendering, click to play, highlight, keys, jump to source, re-render on save, scheduling, inserted pauses, `stall` and `play_start` events.
- [ ] D6. The telemetry summary command and a local `.vsix` build.

### D3. Engine benchmark

- [ ] Delivered

- Run by hand from the owner's machine, with keys from environment variables: Speechify Simba 3.2, Inworld TTS-2 Flash and Gemini 3.8 Flash-Lite TTS; OpenAI gpt-4o-mini-tts if a key is present.
- Input: the first 40 units of a given Markdown file, through the D2 pipeline, rendered by a minimal adapter per engine.
- Measures per request: time to first byte (streaming where the engine offers it), total time, audio duration. Runs once sequentially and once with 3 requests in flight.
- Simulates playback at 1×, 2× and 2.5× with N=6 and C=3 from the measured times, and counts stalls.
- Writes measurements as telemetry `synth` events and audio samples to a directory outside the repo, for listening side by side.
- The branch that delivers D3 adds a `## Benchmark results` section to this spec (p50/p95 per engine, stalls per speed, cost per 1k characters) and records the chosen engine under Decisions.

## Acceptance checks

- Telemetry files written while reading a test document that contains a unique marker string never contain that string. Catches document text leaking into telemetry or logs.
- For every unit of the specs in `vertex-ai-models-chat-provider` and in this repo, the deterministic processor's output passes the verbatim guard. Catches rules that drop or reorder words.
- A processor that returns altered words for a unit is replaced by the deterministic output for that unit, and a log line records it. Catches a guard that only logs.
- Editing one sentence and saving re-synthesizes exactly one unit (telemetry: one `synth` with `cacheHit: false`). Catches unit ids that shift after an edit.
- Reading spec 0001 of `vertex-ai-models-chat-provider` from the first unit to the end at 2.5×, cache empty, records zero `stall` events after the first unit. Catches scheduling that keeps up on average but not in the worst case.
- Click to first sound: p95 at most 1 s with the cache empty, at most 200 ms with the cache warm (telemetry `play_start`). Catches a slow start.
- Changing speed during playback makes no `synth` request. Catches speed applied by the engine instead of the player.

## Open questions

- Accounts and keys: the owner opens pay-as-you-go accounts for the benchmarked providers (Speechify, Inworld) before D3.
- Latency targets: are 1 s (cold) and 200 ms (warm) for click to first sound the right bar?
- Code blocks: skip silently (current proposal), or read them?
- Language: specs are in English. Should Italian documents be supported (voice per language), or deferred?
- Should the panel follow the editor's cursor (click in the source to set the start point), or is the button-plus-click flow enough for now?
