# Changelog

All notable changes to the **Markdown Reader** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- Draft reader: **Read Aloud** in the editor title bar of Markdown files opens a panel beside the editor. Click a sentence to hear the document from there, highlighted as it goes, with Inworld TTS. Speed from 1× to 2.5× (Space, ← →, + −), language, voice and model (Flash or TTS-2) selectors, double-click or `E` to jump to the source line, estimated spend for the session and the month. Audio plays through ffplay (FFmpeg) when it is installed, since some VS Code builds, such as the snap, have no sound in webviews; `markdownReader.audioOutput` chooses. A "Markdown Reader" output channel says which output is used. Speed from 0.75× to 3× with a slider, or `+`/`−` in steps of 0.1. **Markdown Reader: Clear Audio Cache** deletes all cached audio after confirmation.

### Changed

- The extension's identity and display name now match Markdown Reader (`jorsm.markdown-reader`).

### Fixed

- Reopening the reader after closing its panel works again: it no longer fails with "Webview is disposed". Stopping while a sentence is being loaded no longer plays it anyway.
