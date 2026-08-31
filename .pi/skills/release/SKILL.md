---
name: release
description: Release pi-herdr-agents when the user explicitly requests a release, version bump, or package publication. Run the complete local release gates, create the version commit, push main, and verify the GitHub release workflow.
---

# Release pi-herdr-agents

Read [`RELEASING.md`](../../../RELEASING.md) before you act. It is the canonical release contract.

## Prepare the release

1. Confirm that the user explicitly requested a release. A release includes a version commit and push to `main`.
2. Inspect `git status --short`, `git branch --show-current`, and `git log --oneline -3`. Release only from a clean `main` branch. Stop when unrelated changes are present.
3. Run `git fetch --tags --prune origin`. Confirm that `main` can push without overwriting remote work.
4. Select `patch`, `minor`, or `major`. Use the requested increment. For an unambiguous compatible bug fix, use `patch`; otherwise ask the user to choose.

## Verify the release candidate

1. Run `npm ci`.
2. Run `npm run format:check`, `npm run lint`, `npm test`, `npm pack --dry-run`, and `git diff --check`.
3. Load and follow [`../run-integration-tests/SKILL.md`](../run-integration-tests/SKILL.md). Run its deterministic Herdr suite. Do not treat skipped Herdr tests as passing evidence.
4. Inspect the package preview. It must include `CHANGELOG.md`, `skills/orchestrate/SKILL.md`, and `pi-extension/subagents/workflow-worker.js`. It must exclude plans, journals, sessions, prototypes, generated evidence, and local configuration.

## Create and push the release

1. Run `npm version <increment> --no-git-tag-version`. This updates `package.json`, `package-lock.json`, and `CHANGELOG.md`. Do not create a local tag.
2. Inspect the version and changelog diff. Stage only `package.json`, `package-lock.json`, and `CHANGELOG.md`.
3. Commit with `chore: release v<version>`.
4. Push with `git push origin main`.

## Verify publication

The push triggers the GitHub **Release** workflow. It publishes to npm, then creates the matching tag and GitHub Release.

1. If GitHub CLI access is available, inspect the workflow result. Otherwise report that publication is pending in **Actions**.
2. After the workflow succeeds, run `npm view pi-herdr-agents` and confirm the published version.
3. Report the version, release commit, push result, workflow or publication state, every check result, and any required user action.
