# Repository instructions for agents

These instructions apply to humans and coding agents changing `pi-herdr-agents`.

## What this package is

`pi-herdr-agents` (Pi Herdr Agents) is a Pi extension that launches asynchronous Pi child agents exclusively in Herdr. Legacy Herdr runs group child panes in extension-owned `Agents` tabs by default. Local Herdr Core supports ordinary native execution; Desktop placement/sidebar parity and Core managed worktrees remain unsupported ([ADR-0018](docs/adr/0018-herdr-core-execution.md)). Writing tasks may opt into one isolated Herdr-managed Git worktree per branch. Legacy role definitions that request an external CLI fail before Herdr creates resources.

The package is a pack-neutral execution host: it ships no agent roles and no planning or review workflows. Its only skill is `pi-herdr-agents`, a general operating guide for the host; do not add methodology or workflow skills here. Roles come from project or global definitions and separately installed role packs. Do not add bundled roles, a privileged default pack, or name-keyed workflow behavior; see [ADR-0013](docs/adr/0013-pack-neutral-execution-host.md).

The extension is fire-and-forget: `subagent` returns an acknowledgement, and completion is delivered to the parent automatically. Never add polling guidance that tells callers to sleep, tail sessions, or repeatedly check status. The one sanctioned loop is a watcher: a persistent specialist launched with `notify: true` that owns its timer and wakes the parent through `caller_notify` ([ADR-0019](docs/adr/0019-specialist-notices.md)).

## Read these first

- [`README.md`](./README.md) — canonical installation and everyday-use guide
- [`docs/tools.md`](docs/tools.md), [`docs/configuration.md`](docs/configuration.md), and [`docs/roles.md`](docs/roles.md) — canonical API and lifecycle, configuration, and agent-authoring references
- [`docs/README.md`](docs/README.md) — map of shipped contracts, active design, ADRs, and background research
- [`CONTEXT.md`](CONTEXT.md) — workflow-domain glossary; read it before changing orchestration design
- [`docs/adr/0003-installable-role-packs.md`](docs/adr/0003-installable-role-packs.md) — installable role-pack discovery, precedence, and collision contract
- [`docs/adr/0013-pack-neutral-execution-host.md`](docs/adr/0013-pack-neutral-execution-host.md) — role-free host ownership, removed commands, and `roles.bundled` deprecation
- [`docs/worktree-subagents.md`](docs/worktree-subagents.md) — canonical worktree operating, review, recovery, and cleanup guide
- [`RELEASING.md`](RELEASING.md) — release checks and publishing procedure

Former bundled roles, `/plan`, its plan skill, and `/skill:orchestrate` now belong to the separately maintained `pi-herdr-roles` and `pi-herdr-pstack` packs. `/iterate`, `/btw`, and `/btw-close` were removed. Do not reintroduce them here.

## Code map

The engine is the exact `@nubl/maestro` dependency: run ownership, the Pi harness adapter and launch transactions, tool schemas and registration, per-load controllers, config loaders, role discovery, worktree operations, the child protocol, and the accept check. This package is the terminal host around it and imports engine modules only through `@nubl/maestro` subpaths. Change engine behavior in `@nubl/maestro`, then raise the exact dependency here; never recreate a local copy of a moved module.

- `pi-extension/subagents/index.ts` — the terminal entry Pi loads: calls `createPiExtension` from `@nubl/maestro/pi` once per module load with the host's hooks (`hostSurfaceBinding`, presentation hooks, child wrapper path, config asset root) and re-exports the `__test__` surface
- `pi-extension/subagents/host-surface.ts`, `marker-transport.ts` — the terminal host's runtime composition: legacy/Core binding selection, the owning provider, the per-launch legacy pane provider, and the Herdr socket sidebar-marker transport
- `pi-extension/subagents/widgets.ts`, `renderers.ts`, `tool-renderers.ts` — the terminal presentation hooks: widget and status refresh with `borderLine`, the message renderers, and the injected tool `renderCall`/`renderResult` callbacks
- `pi-extension/subagents/child.ts`, `child-widget.ts` — the terminal child wrapper (`createChildExtension` from `@nubl/maestro/pi/child`) and its tools widget
- `maestro/adapters/pi/child/subagent-done.ts` — the launched child path that old launch artifacts and session policies name; it re-exports the package child protocol and forwards to the terminal wrapper
- `maestro/surfaces/herdr/` — `HerdrSurfaceProvider`, Herdr CLI driver (`herdr-cli.ts` bounded asynchronous exec, `herdr-pane.ts` pane inspection and readiness, `herdr.ts` placement, worktrees and pane commands), and terminal scripts (`terminal.ts` reads the pane shell from `pane process-info`), plus `herdr-socket.ts` for socket pane metadata
- `maestro/surfaces/herdr/herdr-core-protocol.ts`, `herdr-core-surface-provider.ts` — bounded native Core RPC, atomic-start uncertainty, per-launch ownership, confirmed termination and delivery-gated record removal; no Desktop layout or worktree operations
- `plugins/sidebar/` — optional standalone Node companion Herdr plugin; it imports nothing from the extension
- `test/maestro/` — host seam tests: Herdr and Core providers and transports, composition hooks, the dependency-rule test, and the conformance runners `test/integration/` drives against the real providers; engine unit tests and conformance fakes run in `@nubl/maestro`
- `CONTEXT.md` — orchestration-domain glossary
- `docs/adr/` — hard-to-reverse architectural decisions; [ADR-0012](docs/adr/0012-adopt-maestro-seams-in-repo.md) records the maestro seams decision
- `docs/research/` — evidence and alternatives, never the shipped contract
- `scripts/update-tool-docs.ts`, `scripts/tool-docs.ts` — regenerate `docs/tools.md` blocks and the tool-schema snapshot (`npm run docs:tools`) from the host entry; the breaking-change check against the released contract runs in `@nubl/maestro`, and `test/fixtures/tool-schema/released.json` is this package's last released contract
- `test/test.ts` — host unit tests that need the terminal entry, the Herdr providers, or terminal presentation
- `test/package-manifest.test.js` — package manifest and pack-neutral package-content contract test, including the exact `@nubl/maestro` dependency and that the package ships exactly the host modules its Pi entry loads
- `test/integration/` — real Herdr and Pi lifecycle tests using the deterministic provider by default; `test/integration/agents/` holds test-only role fixtures, including the multi-wave `test-coordinator`
- `test/bench/supervision-bench.mjs` — manual isolated-Herdr supervision transport benchmark; raw samples stay in `/tmp/issue29-bench/`

## Worktree contract

Preserve these invariants when changing worktree behavior:

1. `worktree: { branch, base? }` is opt-in per `subagent` call.
2. `cwd` selects the source repository; the child starts at the created worktree root.
3. `base` resolves to an exact commit before creation and defaults to committed `HEAD`.
4. Parent uncommitted/untracked files are not copied.
5. An ownership manifest is written before Herdr resource creation.
6. Herdr creates the workspace without stealing focus; launch targets the returned root pane explicitly.
7. Successful, failed, and help-requesting runs retain their worktree workspace.
8. Completion reports reviewable Git state; inspection failures are unknown, never guessed clean or conflict-free.
9. The extension does not push, create PRs, merge, cherry-pick, switch the parent checkout, or remove worktrees automatically. Explicit parent-owned cleanup uses cwd containment and fail-closed eligibility; branches are never deleted.
10. Ordinary non-worktree subagent behavior remains unchanged.

Read [`docs/worktree-subagents.md`](docs/worktree-subagents.md) before changing any of these semantics.

## Orchestration guidance

- Use ordinary panes for read-only scouts and reviewers.
- A single or sequential writer can work in the parent checkout; reserve unique worktree branches for independent parallel writing tasks.
- Keep overlapping or dependent writing tasks sequential unless the dependency is committed and used as the next exact base.
- Tell worktree workers whether to commit. A good default is: edit, test, commit, report the SHA, and do not push/merge/remove.
- The parent owns review, integration, publication, and cleanup.
- Do not use `subagent_resume` as if it reattached worktree ownership; v1 resumes into an ordinary pane.

## Documentation synchronization

When behavior changes, update every affected surface in the same commit:

- public tool parameters or lifecycle → run `npm run docs:tools` to regenerate the marked blocks in `docs/tools.md` and `test/fixtures/tool-schema/current.json`, edit the prose by hand, plus the `README.md` summary when everyday use changes and the operating guide in `skills/pi-herdr-agents/SKILL.md` when agent behavior changes
- report envelope, host evidence, or tool-schema compatibility → `docs/delegation-outcome-contract.md`
- configuration keys, model routing, or task-model init events → `docs/configuration.md`, plus the `README.md` summary when everyday use changes
- role-pack protocol or role frontmatter → `docs/roles.md`
- troubleshooting steps → `docs/troubleshooting.md`
- code map → this file and `docs/development.md`
- role-pack discovery, precedence, or collision policy → `docs/adr/0003-installable-role-packs.md`
- worktree behavior, handoff, recovery, or cleanup → `docs/worktree-subagents.md`
- role prompts, `/plan`, and review-workflow methodology → the owning role pack, not this repository
- the `PI_SUBAGENT_ID` child-context hint → `docs/tools.md` and `CONTEXT.md`
- contributor/release verification → this file, `docs/development.md`, `.pi/skills/verify-pi-herdr-agents/SKILL.md`, `.pi/skills/run-integration-tests/SKILL.md`, or `RELEASING.md`
- domain terminology → `CONTEXT.md`
- hard-to-reverse orchestration trade-offs → the relevant ADR; do not create an ADR for every design question
- architectural evidence and alternatives only → research docs, clearly marked when later decisions supersede them

Do not copy the full worktree guide into every role prompt. Keep canonical detail in the guide and add only the role-specific rule an agent needs while running.

## Verification

Use [`.pi/skills/verify-pi-herdr-agents/SKILL.md`](.pi/skills/verify-pi-herdr-agents/SKILL.md) for which gates each kind of change needs, a real parent-Pi drive in an isolated Herdr lab, refactor behavior pins, and how to judge an integration failure.

For normal changes:

```bash
npm test
npm run docs:tools:check
npm run format:check
npm run lint
npm run typecheck
npm pack --dry-run
git diff --check
```

`npm run lint` needs Node.js 22.18+ (or 22.6–22.17 with `NODE_OPTIONS=--experimental-strip-types`) because oxlint imports `oxlint.config.ts` and its `tools/oxlint/anti-slop/index.ts` plugin as TypeScript.

`npm run typecheck` type-checks production sources (`pi-extension/`, `maestro/`, `scripts/`), the TypeScript tests (`test/**/*.ts`), and the verification lab scripts (`.pi/skills/**/*.ts`) under `strict`. Tests run with type stripping, so a type error never fails `npm test`; fix it for the typecheck gate. JavaScript tests (`*.js`, `*.mjs`) are not covered.

The **CI** workflow also has a non-blocking **Unit tests (Windows, non-blocking)**
job on `windows-latest`. After dependency installation, it runs only `npm test`.
It is allowed to fail and must not be cited as passing verification evidence
while that policy remains in place.

For Herdr or lifecycle changes, run the deterministic suite from inside Herdr. Run only one integration suite at a time on a Herdr instance; concurrent suites compete for terminal focus and process capacity and can cause false timeouts or leaked test resources.

When a test reports that a `pi-integ-*` worktree path already exists, first check whether the same test already created that worktree and the deterministic provider dispatched the tool twice after asynchronous completion. Deterministic providers must make each requested tool call one-shot after its started result appears. Remove only verified test-owned residue after confirming that no workspace or process owns it.

```bash
npm run test:integration
```

The separate `.github/workflows/linux-integration.yml` runs the complete
credential-free deterministic suite on Ubuntu with checksum-pinned Herdr binaries.
`scripts/run-linux-integration.ts` reuses the private verification lab and verifies
one real-parent delegation first. Check its result separately from the static/unit
**CI** workflow; neither publishes. Evidence is retained for seven days.
Desktop GUI coverage is deferred. See `docs/development.md`.

Core lifecycle changes additionally require `npm run test:integration:core`. It
starts independent private servers and real parent Pi sessions via
`test/integration/herdr-core-lab.ts` and `core-parent.ts`, without using the
operator's Core/Desktop. Missing binaries cause explicit skips, never passing
evidence. The older verification lab uses Linux `/proc`; report that gate as
unavailable on macOS rather than treating the Core suite as a substitute.

Use `PI_TEST_MODEL="openai-codex/gpt-5.6-luna" PI_TEST_TIMEOUT=180000 npm run test:integration:live` only for optional provider-compatibility smoke coverage. Do not use skipped Herdr tests as passing evidence.

Before committing:

- inspect `git status` and the final diff;
- confirm the package preview includes `CHANGELOG.md`, `README.md`, `config.json.example`, and `pi-extension/subagents/index.ts`, contains no `agents/` resources, no `skills/` resources other than the host-owned `skills/pi-herdr-agents/SKILL.md`, and no `pi-extension/subagents/plan-skill.md`, and excludes `pi-extension/subagents/workflow-worker.js`, plans, journals, sessions, prototypes, generated evidence, local config, and `openspec/`;
- run `npm pack --dry-run` when package contents or documentation paths changed; durable configuration is `$PI_CODING_AGENT_DIR/herdr-agents/config.json`, never package-root `config.json` (move old files manually or re-run `/subagents-init`);
- confirm that no generated plans, journals, sessions, provider configuration, test scripts, or review artifacts are staged; and
- confirm that no accidental empty directory exists at the repository root:

```bash
test -z "$(find . -mindepth 1 -maxdepth 1 -type d -empty -print)"
```

## Release safety

Do not bump `package.json` merely to land documentation or implementation work. A version change on `main` triggers the release workflow. Never commit npm credentials, generated review artifacts, session artifacts, or local `config.json`.
