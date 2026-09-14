# Pinned Pi 0.84.4 regression (issue #47)

Proves this checkout's `pi-extension/subagents/subagent-done.ts` against the
exact upstream Pi source that shipped issue #47's threshold-compaction /
auto-exit interaction, instead of against this repo's own devDependency
version of `@earendil-works/pi-coding-agent`.

## Run it

```bash
npm run test:pi-0844
```

## Version pin

- Pinned upstream commit: `b79e4cc834970cca69daebffab7df1da7d1e52c4`
- Pinned version: `@earendil-works/pi-coding-agent@0.84.4`
- `run.mjs` verifies the downloaded (or supplied) source directory actually
  has that exact version before running anything. A mismatch fails the run
  instead of silently testing the wrong Pi.

Bump the pin only when validating a regression against a different Pi
release; update both `PINNED_COMMIT` and `PINNED_VERSION` in `run.mjs`
together.

## Network bootstrap vs. offline source reuse

By default `run.mjs`:

1. Downloads the pinned commit's source tarball from GitHub.
2. Downloads the pinned `@earendil-works/pi-ai@0.84.4` npm package to
   recover its generated (not committed) provider model-catalog data.
3. Runs `npm ci --ignore-scripts` in the downloaded checkout.
4. Writes a provenance marker (see below) into the checkout.
5. Runs the regression test with that checkout's own bootstrapped `vitest`
   binary, never `npm exec` — so a missing or broken local `vitest` fails
   fast instead of silently trying to install something over the network.

This needs network access and takes tens of seconds. The bootstrapped
checkout is deleted afterward unless you set `PI_0844_KEEP=1`, which retains
it and prints a `PI_0844_SOURCE_DIR=... npm run test:pi-0844` command for a
fully offline repeat run against the same checkout. Only the runner's own
`mkdtemp`-owned temporary directory (and, nested inside it, its own
`ai-pack-*` npm-pack scratch directory) is ever deleted; it never touches
your source checkout, `repoRoot`, or a worktree, and a download or `npm
pack`/`npm ci` failure mid-bootstrap is cleaned up the same way.

### Provenance marker

A bootstrapped checkout is a specific `mkdtemp` output this script created
and fully controlled, not just a directory that happens to report the
pinned `@earendil-works/pi-coding-agent` version. To keep that guarantee
across a `PI_0844_KEEP=1` offline re-run, `run.mjs` writes
`.pi-0844-provenance.json` (`{ repo, commit, version }`) into the checkout
right after bootstrapping, and `PI_0844_SOURCE_DIR` reuse requires that file
to exist and match `UPSTREAM_REPO`/`PINNED_COMMIT`/`PINNED_VERSION` exactly,
in addition to the existing version/generated-data/vitest checks. A
hand-assembled directory that merely matches the pinned version — without
this marker — is rejected. This is a provenance check, not a security
boundary: it does not verify file contents or hashes, so it offers no
guarantee against a deliberately tampered `PI_0844_SOURCE_DIR` value; treat
that environment variable as trusted input, same as any other local path
you point a script at.

## Injected error / stub summary limitations

`issue47-regression.test.ts.template` is ported from a working investigation
harness, not literal upstream test code, and it stubs two things:

- **Compaction summaries** are fixed strings returned from
  `session_before_compact` handlers. They only satisfy Pi's required event
  contract; the tests never assert anything about summarization quality.
- **The abort-shaped provider error** (`stopReason: "error"`,
  `errorMessage: "This operation was aborted"`) in the third test is a
  synthetic response injected through the harness's faux provider. It
  reproduces the error shape the issue describes; it is not proof that
  native Pi compaction alone produces that exact error in production.

The `.template` suffix (rather than `.test.ts`) is intentional: the file
imports `./suite/harness.ts` and `@earendil-works/pi-agent-core`, which only
exist inside the pinned upstream checkout, not in this repo. Keeping it as a
non-`.ts` file stops this repo's LSP, linter, and `npm test` from treating it
as runnable or resolvable here. `run.mjs` renders it into a real `.test.ts`
file inside the pinned checkout at run time, substituting an escaped
absolute import path to this checkout's `subagent-done.ts`.

## Installed test file safety

`run.mjs` writes the rendered test under a random per-invocation filename
(`issue47-pi-herdr-regression-<pid>-<random>.test.ts`) inside the pinned
checkout's own `packages/coding-agent/test/` directory, using Node's
`flag: "wx"` (exclusive create). That means: two concurrent runs against the
same checkout never clobber each other's installed test file, a symlink left
at that leaf path is never followed and overwritten, and cleanup always
means "delete the exact file this invocation created" rather than trying to
remember and restore whatever was at a shared fixed path before. Before
writing, `run.mjs` also resolves the realpath of that `test/` directory and
refuses to install anything if it resolves outside the realpath of the
source checkout, guarding against the directory itself being a symlink to
somewhere unexpected.

## Shutdown assertions use a real AgentSession callback

The second and third test cases bind a real `shutdownHandler` via
`session.bindExtensions()` — the same AgentSession API the production CLI
uses to wire up `ctx.shutdown()` inside extensions. This makes
`subagent-done.ts`'s call to `ctx.shutdown()` invoke a genuine, observable
callback in the test, instead of relying on a synthetic event that merely
claims the process would exit. The bound handler counts invocations and
snapshots the `.exit` sidecar file's content at the moment it fires, so the
tests can assert shutdown happens exactly once, strictly after compaction
and recovery complete, and only after the final `.exit` sidecar has already
been written.
