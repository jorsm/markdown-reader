---
name: prepare-pr
description: The one sequence to run before a branch goes to review in this repo. Runs the checks and agent reviews in order, ticks the spec items or deliverables the branch completes, updates spec status and the specs index, adds the CHANGELOG entry, runs align-agents-md, then hands the branch to the owner with the filled PR template (or opens the PR once the repo is published). Use it whenever a branch is ready for review, when someone says "open a PR", "prepare the PR", "ready for review" or "ship this branch".
---

# Prepare a branch for review

This skill is the only place that states the order of steps before review (spec 0001 D3). `AGENTS.md` and the PR template point here. Run every step in order; when you skip one, say which and why in the Review section. A skipped or failing check is not a pass.

The base is `develop`. Compare against the merge base, including uncommitted work:

```sh
MB=$(git merge-base develop HEAD)
git diff --name-status "$MB"
git ls-files --others --exclude-standard
```

Once the repo has an `origin` remote (spec 0001 D7), fetch first and use `origin/develop` instead of `develop`.

## 1. Branch

- Cut from `develop`, one concern. If the diff carries an unrelated change (a version bump, a refactor, a dependency update), move it to its own branch before going on.
- Name: `spec/NNNN-slug` for spec-only work, otherwise `feat/…`, `fix/…`, `chore/…` or `test/…`. Name the spec items it implements: `feat/0002-d2-text-units`. The type follows Conventional Commits: `fix` only when something was broken.

## 2. `npm run check`

Format check, lint and tests. Fix every failure before going on.

## 3. `/code-review`

Always, on the branch (other tools: their equivalent). Apply the findings that hold up; commit them separately from the feature commits, with their own Conventional Commit message. Note findings you reject and why, for the Details section.

## 4. `/simplify`

Skip only when every changed file is Markdown (docs, specs, skills). Otherwise run it and commit its changes separately.

## 5. Specs

For each spec whose `code` paths the branch touches, or that the branch implements:

- **Deliverable completed:** tick its box (`- [x] D3. …`, or `- [x] Delivered` under a `### D3.` heading). Tick acceptance checks the branch now satisfies.
- **Status:** if the branch ticks the last deliverable, set `status: implemented`. Whenever `status` changes, set `date` to today and change the spec's row in `docs/specs/index.md` in the same commit.
- **Behavior change:** if the branch changes behavior a spec describes, update the spec and call it out in the review. Never rewrite acceptance checks to match what was built.
- **Spec-only branch:** keep `status: proposed` until the owner's review has no more changes, then set `accepted` and `date` (spec and index) in a last commit before merge.

Commit as `docs(specs): …`.

## 6. `CHANGELOG.md`

Add an entry under `## [Unreleased]` when the branch changes what the packaged extension contains or does: code under `src/` or `media/`, settings or commands in `package.json`, runtime dependencies. Do it even when users won't notice. Tests, specs, `AGENTS.md`, skills, scripts and hooks get no entry, and neither do README-only edits.

Use the Keep a Changelog subsections (`### Added`, `### Changed`, `### Fixed`, `### Removed`) and write for users.

## 7. `/align-agents-md`

Run the project skill (other tools: follow `.claude/skills/align-agents-md/SKILL.md`). Keep its report block for the Docs section.

## 8. Re-check

If steps 3 to 7 changed files, run `npm run check` again. In Claude Code the Stop hook also runs it.

## 9. Hand over for review

- **No `origin` remote (today):** don't push and don't merge. Fill `.github/pull_request_template.md` and put it in your final report, with a Conventional Commits title. The owner reviews the diff and merges into `develop` with `git merge --no-ff <branch>`.
- **Published:** push the branch and open the PR against `develop` with the template. When updating an open PR, update its description to match the new commits.
- Either way, fill every section: the spec link (or "none needed" and why); the commands from steps 2 and 8 with their results; the Behavior impact option that applies; the Docs boxes and the align-agents-md report line; the Review box with any skipped steps; out-of-scope findings.

## 10. Report

End with: the branch name (or PR link), the commands run and their results, the steps skipped and why, the spec items ticked, and the filled template when there is no remote.
