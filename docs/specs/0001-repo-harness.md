---
id: "0001"
title: Repo harness
description: Specs, PR workflow, agent instructions, local branch protection and the check gate that every later change relies on.
status: implemented
date: 2026-10-21
supersedes: none
code:
    - AGENTS.md
    - docs/specs/
    - .github/
    - .claude/
    - .husky/
    - package.json
    - test/
---

# 0001 — Repo harness

## Goal

Every change to this repo is **checkable** before it reaches `develop`: an agent or a person can tell whether it kept the intended behavior, respected recorded decisions and stayed in scope.

The repo is also a second trial of the spec-driven workflow used in `jorsm/vertex-ai-models-chat-provider`, on a small project started from zero.

## Context

- The harness is copied from `vertex-ai-models-chat-provider` (its spec 0001), where it was introduced on a mature codebase. Here it exists before any feature code, so every feature starts as a spec.
- The repo started local, with the hooks standing in for a remote, CI and server-side branch protection. It was published as `jorsm/markdown-reader` on 21 Oct 2026 (D7).
- The harness itself was committed once on `main` and `develop` with hooks disabled (`HUSKY=0`), because the hooks it installs block exactly that, and pushed the same way when the repo was created. Every later change goes through a branch and a PR.

## Non-goals

- Publishing to the Marketplace.
- Any reader feature. Those start in spec 0002.

## Decisions

| Decision                                                                | Consequence for the harness                                                                                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Plans are tracked as specs in the repo                                  | `docs/specs/` is the only place for plans, designs and decisions                                                                                |
| Work happens on branches reviewed by the owner                          | Every change, specs included, reaches `develop` through a PR                                                                                    |
| Main agent is Claude Code; Codex and VS Code Copilot chat are supported | One root `AGENTS.md`, no `CLAUDE.md`. Claude Code-only features (skills, hooks) are conveniences; the gate every agent meets is `npm run check` |
| The owner works alone, through agents, and reviews every branch         | No approving review is required; the gate is `npm run check`                                                                                    |
| Published as a public repo, `jorsm/markdown-reader` (21 Oct 2026)       | CI and GitHub branch protection gate `develop` and `main`; the local hooks stay as an early guard                                               |
| Repo text is public once published                                      | Specs, commits and PR texts carry no private remarks, credentials or identifiers                                                                |

## Deliverables

### D1. Specs system

- [x] Delivered

`docs/specs/index.md` (one row per spec, newest first) and `docs/specs/_template.md`. Frontmatter fields, all required: `id` (four digits, never reused), `title`, `description` (what an agent reads in the index to decide whether to open the file), `status`, `date` (last status change), `supersedes` (spec id or `none`), `code` (paths the spec governs).

Rules, the same as in the source repo:

- A change needs a spec when it alters user-visible behavior, a TTS engine, the text pipeline, what is stored or logged, or the harness itself. Typo fixes, dependency bumps and internal renames don't.
- Status values are [MADR](https://adr.github.io/madr/)'s plus `implemented`. `proposed`: under review. `accepted`: approved, deliverables open. `implemented`: every deliverable done. `rejected`: turned down, merged with a `## Why rejected` section. `deprecated`, `superseded`: no longer applies, or replaced by the spec naming it in `supersedes`.
- A spec reaches `accepted` on its own branch, merged before implementation starts; merging it is the approval. Small specs may be accepted with their implementation if the owner agrees.
- Deliverables and backlog items are task-list items, ticked by the branch that completes them. The branch that ticks the last one sets `status: implemented`. Every status change sets `date` and updates the index row in the same commit.
- Specs are never deleted. A spec that changes during implementation is updated on the same branch, and the change is called out in the review. Acceptance checks are never rewritten to match what was built.

### D2. `AGENTS.md`

- [x] Delivered

One root file, at most 150 lines: what this is, a map of what exists, commands, workflow, invariants, test and code rules. It describes only what exists on `develop`; each later branch adds its own rules when it lands.

### D3. Review workflow

- [x] Delivered

- **Branches:** `spec/NNNN-slug` for spec-only work, otherwise `feat/…`, `fix/…`, `chore/…` or `test/…`, always cut from `develop`, one concern each. Conventional Commits.
- **Before review:** the `prepare-pr` project skill (`.claude/skills/prepare-pr/SKILL.md`) is the one place that states the order of checks, reviews, spec and CHANGELOG updates and `align-agents-md`.
- **Review:** PRs against `develop` from `.github/pull_request_template.md`; the owner reviews and merges. `main` only receives release merges from `develop`. Before D7, the owner merged reviewed branches locally with `git merge --no-ff`.

### D4. Check gate

- [x] Delivered

- `npm run check`: Prettier check, ESLint with zero warnings, compile and `node --test`.
- CI (`.github/workflows/ci.yml`, job `build`) runs it on pushes and PRs to `develop` and `main`. Husky `pre-push` runs it locally. Claude Code only: a `Stop` hook (`.claude/settings.json`) runs it before the agent finishes and hands failures back.

### D5. Local branch protection

- [x] Delivered

- `.husky/pre-commit` refuses commits on `develop` and `main`, except to finish a merge (`MERGE_HEAD` present). `git merge --no-ff` runs no pre-commit hook, so local merges work.
- `.husky/pre-push` refuses pushes to `refs/heads/develop` and `refs/heads/main`.
- `HUSKY=0` bypasses both. It is used only for the one-time bootstrap in Context and for the first push in D7.

### D6. Test rules

- [x] Delivered

In `AGENTS.md`: tests assert on what the user or VS Code observes (text, audio requests, timings, files written), never on positional arguments of recorders; each test names the failure it catches; no count assertions tied to data that changes; no production code that tolerates test stubs.

### D7. Publish

- [x] Delivered

Create the public GitHub repository `jorsm/markdown-reader` with `develop` as default branch, push `main` and `develop` once with `HUSKY=0`, add a CI workflow running `npm run check` on pushes and PRs to `develop` and `main`, and enable branch protection on both (PR required, the CI check required, zero approvals, enforced for admins, no force pushes or deletions). Update `AGENTS.md` and D3 to drop the local-merge path, and add the MIT `LICENSE` that `package.json` declares.

## Acceptance checks

- `git commit` on `develop` or `main` fails with the branch-protection message; on a feature branch it succeeds. Catches a hook that was not installed by `npm ci`.
- `git push <remote> develop` fails before contacting the remote. Catches a pre-push hook that only runs checks.
- `npm run check` passes on a clean checkout, and a PR that breaks it cannot merge into `develop`. Catches a harness that cannot gate anything.
- `node .claude/skills/align-agents-md/scripts/check-references.mjs` reports no problems. Catches an `AGENTS.md` naming paths or scripts that don't exist.

## Open questions

None.
