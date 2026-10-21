# AGENTS.md

Instructions for coding agents (Claude Code first; Codex and VS Code Copilot chat supported) and for humans reviewing their work. Keep this file under 150 lines; put plans and designs in `docs/specs/`, not here.

## What this is

A VS Code extension ("Spec Reader") for listening to a Markdown file while following it with the eyes: click a sentence and it is read aloud from there, highlighted as it goes, so long specs can be re-read fast and edited where needed. The reader is not built yet: until its spec is accepted and implemented, `src/extension.ts` is an empty activation.

## Before you change anything

1. Read `docs/specs/index.md`. Open every spec whose `code` paths include files you will touch, and follow it.
2. If the change needs a spec and none covers it (see spec 0001, D1), write the spec first, from `docs/specs/_template.md`.
3. Branch from `develop`. One concern per branch.

Don't create new Markdown outside `docs/specs/`, `.claude/skills/`, `AGENTS.md`, `README.md` and `CHANGELOG.md`.

## Map

- `src/extension.ts` — activation and command registration
- `test/` — Node test runner suites, named `<name>.test.js` (none yet); they import compiled `out/*.js`
- `scripts/` — manual tools, not run by `npm test`
- `docs/specs/` — specs and their index
- `.claude/` — Claude Code Stop hook and project skills (`prepare-pr`, `align-agents-md`)
- `.husky/` — git hooks: local branch protection and the pre-push check

## Commands

| Command | Does |
| --- | --- |
| `npm ci` | Install locked dependencies and the git hooks |
| `npm run compile` | Type-check and emit `out/` with `tsc` |
| `npm test` | Compile, then run every test under `test/` |
| `npm run compile && node --test test/<name>.test.js` | Run one test file |
| `npm run lint` | ESLint on `src/` (zero warnings allowed) |
| `npm run format:check` / `npm run format` | Prettier check / fix |
| `npm run check` | Format check, lint and tests; CI, the pre-push hook and the Claude Code Stop hook run this |
| `npm run bundle` | Production bundle in `out/extension.js` (esbuild) |
| `npx @vscode/vsce package --no-dependencies` | Build a `.vsix` locally (`vsce` is fetched on first use; it is not a dependency) |

Run `npm run check` before you say a change is done, and report which commands you ran and their results. A skipped or failing check is not a pass.

## Branches and review

- The repo is public on GitHub (jorsm/markdown-reader). `develop` and `main` are protected on GitHub (PR and the CI `build` check required) and locally: `.husky/pre-commit` refuses commits on them, `.husky/pre-push` refuses pushes to them. Never bypass the hooks with `HUSKY=0` or `--no-verify`.
- Branches: `spec/NNNN-slug` for spec-only work, otherwise `feat/…`, `fix/…`, `chore/…` or `test/…`, always cut from `develop`. Name the spec items a branch implements: `feat/0002-d2-…`.
- Commits use Conventional Commits (`feat(scope): …`, `fix: …`, `docs(specs): …`); add a body when the reason isn't obvious.
- Before review, run `/prepare-pr` (other tools: follow `.claude/skills/prepare-pr/SKILL.md`). It holds the order of checks and reviews, and the spec and `CHANGELOG.md` updates every branch makes.
- PRs target `develop`, filled from `.github/pull_request_template.md`. `main` only receives release merges from `develop`. The owner reviews and merges; agents never merge.
- Don't bundle unrelated changes (version bumps, refactors, dependency updates) into a branch about something else.
- If you change the behavior a spec describes, update the spec on the same branch and say so in the PR description.
- Spec status (spec 0001 D1): `proposed`, `accepted` (merging the spec PR is the approval), `implemented`, `rejected`, `deprecated`, `superseded`. Deliverables are checkboxes the implementing branch ticks; `/prepare-pr` has the details.

## Invariants

- Repo text (specs, commits, review texts) will be public once published: no credentials, private identifiers or personal remarks.
- Logs carry metadata (counts, sizes, durations, statuses, ids), never document text, credentials or tokens.

## Writing tests

- Assert on what the user or VS Code observes (text, requests made, timings, files written), not on positional arguments of a recorder (`calls.at(-1)[7]`).
- Don't write count assertions that break whenever unrelated data changes.
- Each test names, in its title or a one-line comment, the failure it is meant to catch.
- Don't make production code tolerate test stubs: no optional calls (`?.(`) on methods a type declares as required. Fix the stub instead.

## Writing code

- No `.catch(() => {})` without a comment saying why the failure is safe to ignore. Lint enforces this: put the reason in `// eslint-disable-next-line no-restricted-syntax -- <reason>`, or log the failure instead.
- Exported functions, classes, public methods, interfaces, types and constants have a TSDoc comment (`/** … */`) that says what they do and why, not how. Lint enforces it: `require-jsdoc` from eslint-plugin-jsdoc, `syntax` from eslint-plugin-tsdoc. Comment private code only where the name and types don't explain it.
- Match the existing style; Prettier and ESLint are authoritative. `any` is allowed for SDK and HTTP payloads only.
