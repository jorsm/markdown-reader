# Specs

Plans, designs and decisions for this repo. Read this list before changing code, and open every spec whose `code` paths include files you will touch. Rules for writing and approving specs are in [0001](0001-repo-harness.md#d1-specs-system); new specs start from [`_template.md`](_template.md).

Newest first.

| ID                           | Title        | Status      | Governs                                                                                | Description                                                                                                                                  |
| ---------------------------- | ------------ | ----------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [0002](0002-reader.md)       | Reader       | accepted    | `src/`, `media/`, `scripts/tts-bench.mjs`, `package.json`                              | Read-along panel for Markdown, text pipeline, Inworld TTS with language and voice selection, audio cache, local telemetry and spend tracking |
| [0001](0001-repo-harness.md) | Repo harness | implemented | `AGENTS.md`, `docs/specs/`, `.github/`, `.claude/`, `.husky/`, `package.json`, `test/` | Specs, review workflow, agent instructions, local branch protection and the check gate                                                       |
