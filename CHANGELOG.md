# Changelog

All notable changes to the **Markdown Reader** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- Draft reader: **Read Aloud** in the editor title bar of Markdown files opens a panel beside the editor. Click a sentence to hear the document from there, highlighted as it goes, with Inworld TTS. Speed from 1× to 2.5× (Space, ← →, + −), language, voice and model (Flash or TTS-2) selectors, double-click or `E` to jump to the source line, estimated spend for the session and the month. Audio plays through ffplay (FFmpeg) when it is installed, since some VS Code builds, such as the snap, have no sound in webviews; `markdownReader.audioOutput` chooses. A "Markdown Reader" output channel says which output is used. Speed from 0.75× to 3× with a slider, or `+`/`−` in steps of 0.1. **Markdown Reader: Clear Audio Cache** deletes all cached audio after confirmation.

### Changed

- The extension's identity and display name now match Markdown Reader (`jorsm.markdown-reader`).

### Fixed

- Remote SSH workspaces play audio on the client computer: the reader runs as a local UI extension and opens remote documents through VS Code. Selecting a remote Markdown file in the Explorer reads that file even when another editor is active.
- Reopening the reader after closing its panel works again: it no longer fails with "Webview is disposed". Stopping while a sentence is being loaded no longer plays it anyway.
- Invalid or rejected replacement Inworld keys keep the previous working key. New keys are checked with the free voice-list request, and accepted keys refresh open panels.
- Truncated synthesis responses and empty audio are rejected before caching, allowing the sentence to be retried.
- Pausing while webview audio loads prevents it from starting until playback is resumed.
- Windows uses webview playback rather than selecting ffplay, whose native pause controls require POSIX signals.
- Concurrent requests for identical audio share one synthesis in a window; independent windows use separate temporary cache files.
- Starting playback in another reader stops the previous panel and updates its controls. Opening or closing an idle panel leaves playback running.
- Spend history is appended to dated files per window, so windows cannot overwrite each other's totals; existing history is preserved.
- Sentence splitting preserves Markdown formatting and reference links, speaks link labels without their destinations, and handles locale-specific sentence boundaries.
