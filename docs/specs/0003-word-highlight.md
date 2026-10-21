---
id: "0003"
title: Word highlighting
description: Highlight the word being spoken inside the highlighted sentence, from Inworld's word timestamps mapped back to the rendered text, on both audio outputs.
status: proposed
date: 2026-10-22
supersedes: none
code:
    - src/text/
    - src/tts/
    - src/reader/
    - media/
    - scripts/tts-bench.mjs
---

# 0003 — Word highlighting

## Goal

While a sentence plays, the word being spoken is highlighted inside it, in step with the voice at any speed. Following the text then takes no effort even at 2.5×, and a word that sounds wrong is found at a glance.

## Context

- Spec 0002 highlights one unit (sentence, heading, table row) at a time and lists word-level highlighting as a non-goal for a later spec.
- Inworld returns word timestamps with `timestampType: WORD`, on both `inworld-tts-2-flash` and `inworld-tts-2`, on the unary endpoint the reader uses. Probed on 22 Oct 2026 with one 73-character sentence:
    - the response adds `timestampInfo.wordAlignment` with `words`, `wordStartTimeSeconds`, `wordEndTimeSeconds` (and `phoneticDetails`, not needed here);
    - `words` covers the input text in order with no gaps, spaces and punctuation included (`"Run"`, `" \`"`, `"npm"`, `" "`, …); numbers come split (`"1"`, `"8"` for 18);
    - characters billed are unchanged (73): no extra cost;
    - total time was 0.99 s on Flash and 2.08 s on TTS-2 for that sentence. Inworld's docs warn that timestamps add latency, especially on the non-streaming endpoint; one request proves nothing about the p95.
- The timestamps describe the **spoken** text, which differs from the text on screen: inline code is spoken by rules (`src/utils/retry.ts` becomes "src slash utils slash retry dot ts"), link targets and markup are dropped, table cells are joined. Highlighting needs a map from spoken text back to displayed text.
- The extension knows exactly where the panel's audio element is (`currentTime`), but not where ffplay is: it only knows when ffplay started and how long it has been paused.

## Non-goals

- Starting playback from a clicked word (seeking inside a unit). Clicking a word still starts its unit.
- Karaoke-style per-character or per-phoneme highlighting.
- Changing what is spoken, or how units are split.
- Re-synthesizing audio that is already cached just to get timestamps (see Decisions).

## Considered options

### Mapping spoken words to displayed text

| Option                                                | Pros                                                                               | Cons                                                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Alignment map built with the spoken text** (chosen) | Exact: the text rules know which displayed characters each spoken piece comes from | The `TextProcessor` output grows a map; an LLM processor (spec 0002) must produce one too, or its units fall back to sentence highlighting |
| Fuzzy-match spoken words against the displayed text   | No change to the text pipeline                                                     | Fails exactly where it matters: code, numbers, symbols                                                                                     |

### Knowing where ffplay is

| Option                                                                                                              | Pros                                               | Cons                                                                               |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Wall clock: time since ffplay started, minus pauses, times the speed, plus a fixed offset for audio-device start-up | Simple                                             | Drifts by the device latency (100–300 ms, varies by machine); needs a tuned offset |
| **ffplay's own clock**: run it with its status line on and read the playback time from its stderr                   | Follows the audio actually played, pauses included | Depends on the status line format; to be verified (D1)                             |

The second is chosen if D1 shows the status line is reliable and frequent enough (at least every 100 ms); otherwise the first, with the offset as a setting.

## Decisions

Proposed in this draft (22 Oct 2026), to be confirmed in review:

- Word highlighting on both audio outputs, ffplay and the panel's audio element.
- **Off by default, behind a "Words" checkbox in the panel toolbar** (setting `markdownReader.wordHighlight`, default `false`), because timestamps slow synthesis down. Its tooltip says what it does and the trade-off: "Highlight each word as it is spoken. Asks Inworld for word timings, which makes each sentence slower to prepare (most on TTS-2); no extra cost. Sentences already prepared without timings keep sentence highlighting." (owner, 22 Oct 2026)
- Only synthesis with the checkbox on asks for word timestamps; units already in the cache without them keep sentence highlighting and are not re-synthesized (owner, 22 Oct 2026).
- Clicking a word starts its whole sentence, as today (owner, 22 Oct 2026).
- The sentence stays highlighted as today; the current word gets a second, stronger highlight inside it.

## Behavior and invariants

### Text pipeline

- Each spoken unit carries an **alignment map**: a list of pairs, a spoken character range and the displayed character range it comes from. Text maps to itself; a code span's spoken words all map to the whole code span; dropped markup maps to nothing.
- Displayed offsets count the unit's text as the panel shows it (its text content, whitespace between table cells excluded), so the panel can turn them into DOM ranges without knowing Markdown.
- A processor that cannot produce a map (or whose map does not cover its spoken text) yields none for that unit; the unit gets sentence highlighting only. This includes the verbatim-guard fallback of spec 0002.

### Synthesis and cache

- With word highlighting on, requests ask for `timestampType: WORD`; with it off they don't, and synthesis is as fast as without this spec. The audio cache stores, next to each audio file, its word timings converted to spoken-text offsets (start and end time per spoken character range), under the same cache key.
- Cache key and billing are unchanged. A cached unit without timings is played as before, with sentence highlighting.

### Highlighting

- The panel highlights with the CSS Custom Highlight API (`CSS.highlights`), so the document's DOM is never rewritten while playing.
- For the playing unit the extension sends, once, the word timeline already mapped to displayed offsets: `[startSeconds, endSeconds, displayedStart, displayedEnd]` per word, punctuation and spaces dropped.
- **Panel audio element:** the panel follows `audio.currentTime`.
- **ffplay:** the panel follows a clock the extension feeds (see Considered options), so pause, resume and speed changes stay in step.
- The highlighted word changes no later than 100 ms after the voice starts it, measured by eye on a recording (D4).
- If the timeline is missing, late or does not fit the unit (a re-render changed it), the panel keeps the sentence highlight only; it never highlights the wrong text.

## Deliverables

- [ ] D1. Spike: ffplay's status line as a clock (format, frequency, behavior under `atempo` and SIGSTOP); the result chooses the ffplay clock and is recorded in this spec.
- [ ] D2. Alignment maps from the deterministic text rules, with tests on real specs (code spans, links, emphasis, table rows, numbers).
- [ ] D3. Timestamps requested, stored next to the cached audio, and mapped to displayed offsets; the D3 benchmark of spec 0002 rerun with timestamps on, both models, results recorded here.
- [ ] D4. The word highlight in the panel on both outputs, including pause, resume, speed change and save while listening, and the "Words" checkbox with its tooltip.

## Acceptance checks

- With timestamps on, reading spec 0001 of `vertex-ai-models-chat-provider` at 2.5× from the first unit, cache empty, records zero `stall` events after the first unit, on Flash. Catches timestamps making synthesis too slow to keep up.
- For every unit of the specs in both repos, the alignment map covers every spoken character, and every mapped displayed range lies inside the unit's text. Catches maps that drift off the sentence.
- A sentence with a code span highlights the whole code span while its spoken words ("src slash utils…") play. Catches code spans mapped word by word to the wrong characters.
- Pausing for 10 s and resuming keeps the word highlight in step on ffplay. Catches a clock that keeps running while paused.
- A unit cached before this change, or while the checkbox was off, plays with sentence highlighting and makes no new synthesis request. Catches silent re-synthesis of the cache.
- With the checkbox off, requests carry no `timestampType` and the panel shows no word highlight. Catches timestamps slowing synthesis for owners who didn't ask for them.
- Characters billed per request are the same with and without timestamps (telemetry `charsBilled` equals `charsSent`). Catches a hidden cost.

## Open questions

- If D3 shows timestamps make TTS-2 too slow to keep up at 2.5×, should the checkbox stay usable with TTS-2, or warn when both are on?

Resolved on 22 Oct 2026: no command to re-synthesize cached units with timestamps (a command that clears the whole audio cache is enough, outside this spec); clicking a word starts its whole sentence, no seeking.
