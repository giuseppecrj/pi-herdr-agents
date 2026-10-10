# Pi Herdr Agents Sidebar plan

Status: locally verified and uncommitted, with one accepted limitation. All four
adversarial reviews have reported and the parent has triaged them. Coverage
limits and the completed closing review are in
[Closing verification](#closing-verification). No plugin is installed or
enabled by this work. Nothing is committed, pushed, or
released. See [Implementation status](#implementation-status).

## Goal

Keep main agents easy to find while delegated children remain accessible through
Herdr. Build the optional companion in `plugins/sidebar/`, in this repository.
Its plugin ID is `pi-herdr-agents.sidebar`.

The first version exposes two explicit actions:

- **Focus** hides recognized delegated children, except blocked agents.
- **All** clears only this plugin's view. If another caller replaced the view,
  report that it remains active rather than claiming every agent is visible.

Linking or enabling the plugin does not activate Focus. Missing or unknown child
metadata leaves agents visible. Neither action changes processes, notifications,
Git state, workspaces, tabs, or panes.

## Ownership

The extension owns delegated-run identity and lifecycle. The plugin owns the
visibility query. Do not infer ownership from pane titles, tab names, working
directories, or the inherited `PI_SUBAGENT_ID` hint alone.

Keep these cases distinct:

| Case | Intended treatment |
| --- | --- |
| Main or manually started agent | Visible |
| Explicit interactive `/worktree` handoff | Visible |
| Delegated ordinary or resumed child | Eligible for Focus while recognized |
| Persistent specialist between tasks | Still a delegated process |
| Blocked child | Visible as a conservative attention exception |
| Child process exited; worktree root retained | Remove the child classification |
| Unknown, stale, or unverified identity | Visible |

Herdr's `done` status means idle and unseen. It is not task acceptance. Do not
reveal every completed child as if the user must review it.

## Herdr constraints

The investigated binary is `0.9.2-preview.2026-09-29-8e78f929d8f0`.
The extension baseline is `0bb8bcdc328d152c5cab5eaaf4d261f109055ee4`.

- `agent.view.set` and `agent.view.clear` require socket requests on this build.
- One server-owned view slot is shared by callers. Do not repeatedly reclaim it.
- Filters affect agent rows and agent navigation, not notifications or
  `agent.list`.
- Pane tokens and view overrides do not survive a server restart.
- Token patches are pane-scoped. Presentation guards do not guard token patches.
- Plugins cannot add arbitrary native sidebar controls or hide workspace rows.
- Plugin startup hooks do not run on link, enable, or config reload.
- `min_herdr_version` must be a plain version. This preview rejects
  `0.9.2-preview...` there and reports itself as `0.9.2` to the check.
- Agent authority reported from outside a pane disappears within seconds.
  Tests that need agent rows run a real process in each pane.

Use a self-contained Node entrypoint and built-in modules for the companion.
It must work when Herdr installs only its repository subdirectory. Do not import
the repository's TypeScript host from the plugin runtime.

## Selected contract

The isolated probe at `/tmp/pi-sidebar-probe-C8pr6k/` observed the real rendered
sidebar. Pane tags survive occupant replacement, including explicit agent
release. Presentation guards do not protect tokens. Same-source sequence numbers
reject older writes, but different sources can overwrite the same key. Focus
and source-guarded All work on the installed preview.

Use the small self-contained plugin from the second candidate and the explicit
staleness analysis from the first. Reject a separate lifecycle registry, per-run
metadata sources, unconditional clears, and the invalid `not.filters` shape.
`not` takes one `filter` object.

The metadata marker means recently classified as a delegated child, not proven
live at render time. Use `piha_delegated_v1 = live` with a 15-second TTL and a
stable metadata source. Missing or unknown-valued markers remain visible.
The host owns marking, renewal, and cleanup. Tagging is opt-in and off by default.
Keep writes bounded and ordered, clear during finalization, and stop renewing
when the original run cannot be verified. Do not let a replacement Pi process
inherit an old run's renewal. Use existing identity evidence where necessary;
do not create another registry or add a broad abstraction for presentation.

After the last accepted write, a leftover marker can hide a replacement agent
until the lease expires. A delayed write can move that deadline. Bound transport
attempts, reject retired-attempt results, and do not retry stale renewals.
Normal cleanup should remove the marker promptly, but neither cleanup nor TTL
provides a strict occupant-bound guarantee. Document the limitation and keep All
available. This is a presentation tradeoff, not an authorization boundary.

Do not install a startup hook in the first version. Linking, enabling, or
restarting Herdr does not automatically reapply Focus. Do not add a popup.

## Delivery units

1. Run a disposable API experiment with separate HOME, XDG paths, config, socket,
   and plugin registry. Observe expiry, replacement, delayed writes, and view
   ownership without touching the user's server.
2. Implement the optional plugin actions and bounded socket client. Test exact
   requests, malformed responses, timeouts, missing context, and foreign view
   ownership. Include install, use, and removal instructions.
3. Add the smallest justified metadata bridge only after the experiment settles
   its contract. Preserve the existing layer boundaries and launch behavior.
4. Exercise lifecycle and presentation together on real isolated Herdr resources.
5. Review the final diff and run the repository checks. Leave changes uncommitted
   until the user authorizes commits.

Exclude this active plan from the npm package. Keep shipped behavior in the
plugin README and link it from the main README. Do not change the npm version.

## Verification matrix

- Host without plugin and plugin without tags.
- Known child marker, unknown marker, missing marker, and blocked child.
- Ordinary, resumed, persistent, and delegated worktree children.
- Interactive `/worktree` handoff and manual reuse of a retained root pane.
- Normal exit, abrupt exit, parent failure, and unavailable socket.
- Delayed metadata writes and stale lease expiry.
- Two parent sessions, repeated actions, and a competing view owner.
- Disable, unlink, server restart, and restoration with missing ownership data.
- Package contents and installation from a repository subdirectory.

Remote-machine and multiclient behavior needs its own verification. Do not claim
support from local API tests. `agent.list` alone is not rendered-sidebar evidence.

Required repository checks are `npm test`, `npm run format:check`, `npm run lint`,
`npm pack --dry-run`, `git diff --check`, and changed-TypeScript diagnostics.
Run lifecycle integration tests serially on an isolated instance. Do not run
concurrent suites against one server.

## Scope exclusions

No popup manager, native grouping, workspace hiding, notification suppression,
automatic recovery, process controls, automatic cleanup, new lifecycle registry,
or private-session scanning. No installation into live user configuration,
commits, pushes, pull requests, or releases without separate authorization.

## Implementation status

Delivery units 2 to 5 are implemented in the working tree and reviewed. See
[Final verification record](#final-verification-record). Shipped behavior is described in
[`plugins/sidebar/README.md`](../plugins/sidebar/README.md) and the main
README's sidebar markers section.

- Plugin: `plugins/sidebar/` with `herdr-plugin.toml`, `sidebar.mjs`, and a
  README. The manifest declares `min_herdr_version = "0.9.2"` and
  `platforms = ["linux"]`, because Herdr accepts only plain versions and the
  host marks nothing outside Linux.
- Host setting: `sidebar.enabled` in `config.json`, `false` by default.
- Marker owner: `maestro/runtime/delegated-marker.ts`, attached per launched
  attempt in `maestro/runtime/pi-run-session.ts`. It publishes only after the
  existing process-identity capture verifies the child, renews from the
  existing supervision observations at most every 4 seconds, and retires on
  finalization, suppression, a missing pane, an exited or unverifiable
  identity, or three failed writes in a row.
- Transport: `maestro/surfaces/herdr/herdr-socket.ts`, one request per
  connection, a 2-second timeout, a 64 KiB reply bound, and an unreferenced
  socket and timer.

Deviations from the plan text, each the least invasive option found:

- Ordinary and resumed children now record the same process-identity sidecar
  as worktree children when the setting is on. A resumed child records under
  the parent's artifacts by run ID, because the session's own sidecar keeps the
  first identity ever published. Cancel behavior is unchanged: only worktree
  cancels use the identity.
- Renewal reuses supervision observations instead of a new timer. If
  supervision stalls, markers expire and children reappear.
- A reload adopts the running children's markers and their shared sequence.
  When the reloaded setting is off, the adoption retires every marker at once,
  pending ones included, and clears each one that may have reached Herdr.
  A retired marker never writes `live` again, even after a late identity
  verification or a later re-enable; re-enabling marks only new launches.
- Not verified here: server restart, saved-machine clients, macOS, and
  Windows.

## Review status

Use fresh bare reviewers with explicit prompts and cross-family model selection,
following Poteto mode. This repository does not require a named reviewer role.
The initial named-role attempt incorrectly applied another repository's policy;
it is not a prerequisite for this work. The bare cross-family review preferred the small plugin structure with explicit
bounded-staleness semantics. The parent checked the probe's rendered output and
source-guarded clear results before selecting this contract.

A cross-family implementation review (sidebar-review-3, OpenAI gpt-6-astra),
confirmed by the parent, found two defects, both fixed in the working tree:

1. A reload with `sidebar.enabled` turned off kept renewing the markers of
   children that were already running. The adoption now retires them, as
   described above. The plugin README also no longer claims that a later pane
   occupant never inherits a marker: it does not inherit renewal, but can see
   a marker until its TTL ends.
2. Marker composition tests spawned `sleep` and read `/proc`, so they failed
   off Linux and could leak the child on a failed assertion. They now inject a
   fake process probe and run on any host. The real-process sidebar lifecycle
   suite is skipped off Linux, where the host marks nothing.

A later full-feature review (sidebar-review-4) approved the marker and plugin
behavior but withheld approval over two defects in the real-process lifecycle
fixture, `test/integration/sidebar-lifecycle.test.ts`. Both are fixed in the
working tree:

1. The fixture waited for exactly two live markers anywhere on the server and
   took any marked pane outside its own workspace as its worktree child. With
   an unrelated marked pane present and its own worktree marker missing, it
   selected the unrelated pane, and cleanup force-removed that worktree. The
   fixture now finds each child by launch record and process identity, scopes
   every marker assertion to its own panes, and removes only a worktree that
   its launch record and Herdr's inventory of its own repository agree on.
2. Cleanup knew the worktree only after both markers appeared, and the failure
   path read the parent pane before cleanup. A missing marker or a failed read
   left the fixture's own worktree behind, and `afterEach` then deleted its
   source repository. Cleanup is now registered before the parent starts. It
   first stops the parent pane's processes, so nothing the parent started can
   create a worktree after the scan. If ownership is unknown or removal fails,
   `afterEach` keeps the source repository and reports the residue.

The ownership rules live in `test/integration/sidebar-fixture.ts`.

A further review (sidebar-review-5) confirmed both fixes and found no
isolation defect in the pane quiescing. It found two defects in the foreign
canary, the marked worktree the fixture creates to stand in for another
parent's launch. Both are fixed in the working tree:

1. Teardown removed the canary's worktree only when Herdr listed it open in
   the recorded workspace. It then always closed the source workspace and
   deleted the source repository. With an unreadable inventory or a closed
   worktree workspace, the checkout was left pointing at a deleted repository.
2. Setup created the repository, source workspace, and worktree before it
   checked for a socket, and its caller learned of them only when setup
   returned. A refused marker or a missing socket left all three with no
   owner.

Both defects came from one premise: the canary was treated as throwaway
setup, outside the fail-closed rules for the fixture's own launch. The canary
is now owned on the same terms. Setup checks the socket first and records
each resource before it requests the next one, including a launch record
written before `worktree create`. `afterEach` releases the canary on the same
path as the launch. Both use one routine, `removeOwnedWorktree`, which removes
only a worktree that the record and Herdr's inventory of the canary's own
repository and unique branch agree on, then requires it to be absent. The
source workspace and repository go only after that. Otherwise they stay, and
the report names the residue.

The review noted here was later completed; see the final verification record.

## Verification record

Correction pass for sidebar-review-3, on Linux with Node 26.8.2:

- The new reload regression tests failed before the fix (live marker never
  cleared; a pending marker published `live` after the setting was off) and
  pass after it. The enabled-to-enabled reload test passes both ways.
- `npm test`: 958 passed, 0 failed, 1 skipped (a fixture-specific skip that
  predates this work).
- `npm run format:check` and `npm run lint`: clean.
- Strict `tsc --noEmit` (`--module nodenext --target es2023 --strict`) on the
  changed TypeScript files: clean. LSP diagnostics: no type errors.
- Isolated Herdr lab, run serially: `test/integration/sidebar-lifecycle.test.ts`
  3 of 3 passed, including a real parent `/reload` after turning the setting
  off; `test/integration/sidebar.test.ts` 8 of 8 passed. Against the pre-fix
  composition, the reload test failed with markers still present 8 seconds
  after `/reload`.
- The full integration suite was not rerun in this pass. An earlier run on the
  same lab setup passed 88 of 88 before these fixes.

Correction pass for sidebar-review-4, on Linux with Node 26.8.2. Every lab run
used a fresh isolated Herdr server with its own HOME and socket, one suite at a
time. Reproduction scripts and logs are outside the repository, under
`/tmp/sidebar-build-5/`.

- The original fixture, run unchanged from a copy, reproduced both defects
  twice each. With a disposable canary worktree marked live by the lab, and
  the fixture's own worktree marker held absent, it selected the canary and
  cleanup deleted the canary's checkout and workspace. Two triggers did this,
  each twice: a clear from another metadata source, and a highest-sequence
  write from the host's own source. With the setting off, the marker wait
  timed out and the fixture's own worktree outlived cleanup and `afterEach`.
  With the parent pane closed, the diagnostic read threw and cleanup never ran.
- New lab regression tests: a foreign marked worktree stays untouched and
  marked while the fixture removes its own worktree, and a launch that fails
  mid-acquisition is stopped and cleaned up even when the diagnostic read
  throws. The second test has caught the launch record both before and after
  Herdr created the worktree. Both cases were cleaned up.
- `test/integration/sidebar-lifecycle.test.ts`: 5 of 5 passed in three lab
  runs. `test/integration/sidebar.test.ts` passed 8 of 8 in the same run as
  the second. Postflight inside the lab showed no fixture workspace, worktree
  checkout, or `/tmp/pi-integ-sidebar-*` file left.
- `test/maestro/sidebar-fixture-ownership.test.ts` covers the ownership rules
  and the pane quiescing. Mutations that drop the freeze, kill an in-flight
  `herdr` request, ignore a workspace mismatch, or skip the launch-record
  check each fail it.
- `npm test`: 967 passed, 0 failed, 1 skipped (the same pre-existing skip).
  `npm run format:check`, `npm run lint`, `git diff --check`, and the root
  empty-directory check: clean. Strict `tsc --noEmit` on the three changed
  TypeScript files: clean. LSP: all three confirmed clean.
- The full integration suite was not rerun in this pass.

Correction pass for sidebar-review-5, on Linux with Node 26.8.2. Scripts and
logs are under `/tmp/sidebar-build-6/`. The census of every resource
allocator added by this work is `scripts/census.sh`. It found the canary to
be the only allocator with return-only ownership and unconditional deletion.

- Before the fix, the original canary functions were run byte for byte
  against a stand-in `herdr` on `PATH` and a fake socket, with no real Herdr.
  With a closed worktree workspace or an unreadable inventory, teardown
  deleted the repository and left the checkout. With a refused marker or no
  socket, setup threw after it created the repository, two workspaces, and
  the worktree, and returned nothing.
- `test/maestro/sidebar-fixture-ownership.test.ts` now runs the real
  `acquireCanary` and `releaseCanary` against a stand-in Herdr over real Git.
  It covers verified teardown, a closed checkout removed with Git, an
  unreadable, garbled, or mismatched inventory, failed removals, setup
  failures before and after the worktree is requested, and lost Herdr
  answers. Mutations that delete the source despite residue, skip the closed
  checkout, check the socket late, register the worktree after it is
  created, ignore a garbled workspace list, or skip the recheck each fail
  it. It passed twice in a row.
- Two new isolated Herdr tests: a canary whose worktree workspace was closed
  is kept while the inventory is unreadable, then removed through Git once
  verified. When the real server refuses the canary's marker, teardown
  removes the worktree, workspace, and repository.
- Three fresh labs, one suite at a time:
  `test/integration/sidebar-lifecycle.test.ts` passed 7 of 7;
  that file and `test/integration/sidebar.test.ts` passed 15 of 15 together;
  the four foreign, canary, and mid-acquisition tests passed 4 of 4.
  Postflight in each lab showed only the runner's workspace, no worktree
  directory, and no new `/tmp/pi-integ-*` path.
- `npm test`: 976 passed, 0 failed, 1 skipped (the same pre-existing skip).
  `npm run format:check`, `npm run lint`, strict `tsc --noEmit` on the three
  changed TypeScript files, and LSP: clean.
- Open finding, not fixed: in the second lab, two processes outlived the
  run, a worktree child's hold loop and its `sleep`. The launch ID dates them
  to "clears a killed child's marker". That test kills the child's Pi
  process, which orphans the loop. The likely cause is that `cleanupTestEnv`
  deletes the gate file before the loop's next check. The loop then runs out
  its 120-second bound. The lab runner killed both. This pass did not change
  that test or the gate. The other two labs reported no such process.
- The full integration suite was not rerun in this pass.

Fix for the orphaned hold loop, on Linux with Node 26.8.2. Scripts and logs
are under `/tmp/sidebar-build-7/`. The final review is recorded in the final verification record.

- Cause, reproduced before the fix in three fresh labs with a watcher that
  logged gate files and hold processes: Pi's bash tool starts each hold in a
  session of its own and kills it only on `SIGHUP` or `SIGTERM`. After the
  test sends `SIGKILL` to the worktree child's Pi, `systemd --user` adopts
  the child's hold, and only the gate can end it. `releaseLaunch` wrote the gate,
  and `afterEach` deleted it about 50 ms later, inside one 200 ms poll. Two of
  the three runs missed the gate, and the loop outlived the passing test
  until the lab runner killed it. The ordinary child's hold, whose Pi was
  alive, exited both times.
- Each hold now writes its own PID next to its marker, from `holdCommand` in
  `test/integration/sidebar-fixture.ts`. `readHold` pins that PID by its
  kernel start time while the command line still names the launch's gate. A
  hold that never wrote its start file is never awaited. `releaseLaunch`
  opens the gate, then waits up to 10 seconds for each pinned hold to exit
  before it removes the worktree. A hold still running is residue, so
  `afterEach` keeps the gate and the evidence.
- The killed-child test now asserts that the orphaned hold still runs after
  both Pi processes die, then releases the launch and asserts that no pinned
  hold runs. Without the wait, that assertion failed with both holds
  running.
- After the fix, the killed-child test passed in two fresh labs, and
  `test/integration/sidebar-lifecycle.test.ts` with
  `test/integration/sidebar.test.ts` passed 15 of 15 in a third. In all three,
  the lab runner found no process using the lab HOME before its own fallback
  kill, and every hold exited after its gate appeared and before it was
  deleted.
- `npm test`: 978 passed, 0 failed, 1 skipped (the same pre-existing skip).
  `npm run format:check`, `npm run lint`, strict `tsc --noEmit` on the three
  changed TypeScript files, and LSP: clean.
- The full integration suite was not rerun in this pass.

## Final verification record

Superseded in part by the [Adversarial audit record](#adversarial-audit-record).
The checks below are the local targeted history. They are not a universal
green result.

Resolved: the earlier "final review pending" lines, the orphaned hold loop,
and the killed-child test race. Entries above that describe failures are
history, not current risks.

Review: sidebar-review-6 (`openai-codex/gpt-6-astra`, fresh) approved the
build 6 and build 7 safety corrections with zero blocking and zero
should-fix findings. Its scope was the canary, the hold, and cleanup after
partial acquisition. It ran the 20 ownership unit tests, a strict TypeScript
compile, and the diff and root checks. Production code and the plugin were
reviewed earlier in sidebar-review-3 and sidebar-review-4. This is not an
independent approval of the whole codebase.

Final parent checks on the reviewed revision, on Linux with Node 26.8.2.
The isolated integration rerun followed the review approval:

- Sidebar integration suites, run serially in a fresh isolated Herdr:
  15 passed, 0 failed, 0 skipped
  (`/tmp/piha-sidebar-parent-approved-integration/output.log`,
  `/tmp/piha-sidebar-parent-approved-runner.log`). The runner's only
  leftover was its own workspace at postflight. No worktree directories
  remained. No process used the lab HOME before the runner's fallback kill,
  and the lab was removed.
- `/tmp` entries: `/tmp/piha-sidebar-final-tmp-before.txt` and
  `/tmp/piha-sidebar-final-tmp-after.txt` are identical, so the original 7
  entries were preserved.
- `npm test`: 978 passed, 0 failed, 1 pre-existing skip
  (`/tmp/piha-sidebar-parent-reviewed-unit.log`). Format check, lint, and
  strict `tsc --noEmit` on all changed TypeScript files passed. LSP is clean
  on the last three changed TypeScript files.
- Package preview (`/tmp/piha-sidebar-parent-reviewed-pack.json`): the
  plugin adds only `plugins/sidebar/herdr-plugin.toml`, `README.md`, and
  `sidebar.mjs`. It lists no test files and not this plan
  (`.npmignore` excludes it). `package.json` version stays 3.1.0.
- `git diff --check` and the root empty-directory check passed.

Current risks and gaps:

- The earlier full integration run (88 passed) predates the final fixes. The
  15 above are targeted. The full suite was not rerun, because later changes
  touched only the sidebar and its tests.
- Remote machines, multiple clients, Herdr restart, macOS, and Windows are
  unsupported or untested.
- The optional live-provider run was skipped. The deterministic provider is
  enough for this work.
- No commit, push, install, or pull request was authorized or made.

## Adversarial audit record

This record retracts the universal-green reading of the earlier final
verification. The targeted local runs above stay as history.

Independent verification ran a frozen copy of the source in a fresh PID,
network, and mount namespace sandbox. Details, commands, and raw output are in
`/tmp/piha-sidebar-adversarial-up9g8W/evidence/test/REPORT.md`.

- `npm test`: 979 tests, 977 passed, 1 failed, 1 skipped. The failing test,
  the `launch.test.ts` readiness test, assumes a root-owned PID 1. The sandbox
  PID 1 is readable by the same user. The test passes 1/1 in an ambient PID
  namespace. The full suite was not rerun there. The test predates this work.
- Full integration suite: 93 tests, 92 passed, 1 failed. The failure is the
  `sidebar.test.ts` case "stops marking once the child exits, and a later
  occupant is never hidden", which timed out waiting for the exited child's
  row. It passed in 4 targeted reruns. This failure record stays as history.
  The cause and fix are in [Exited-child test race](#exited-child-test-race).
- Package: 16 of 16 checks passed, including the extracted tarball and no
  Focus after a Herdr server restart. This does not prove a registry
  `herdr plugin install`.
- Five empty `pi-integ-*` directories remained under the lab
  `.herdr/worktrees` after the full integration run. They are not attributed
  to a suite or to this change.
- Format check, lint, and `git diff --check` passed.

Product finding, accepted by the user as a documented limitation with no code
change: the marker belongs to the pane. Evidence is in
`/tmp/piha-sidebar-adversarial-up9g8W/evidence/replacement/pp3/timeline.txt`
and `results.json`. A suspended original Pi child (Ctrl-Z, state `T`) stayed
alive, and the production marker code kept renewing its marker. A manually
started Pi in the same pane stayed hidden under Focus for 48 to 69 seconds.
All revealed it, and killing the original cleared the marker. The test used a
supervision loop stand-in, not the full `subagent` tool path. Both Pi processes
shared a pane and name, so row binding is not proven. The foreground process ID
was verified. Killing the original cleared the marker within about 2 seconds, and
the new row then appeared under Focus. The documented workaround is in the
plugin README under
[Reusing a delegated pane](../plugins/sidebar/README.md#reusing-a-delegated-pane).

Documentation edits in the earlier pass: the plugin README, the sidebar
markers section of the main README, and `docs/README.md`. They changed no
code, tests, or configuration. They also record the backward wall-clock
caveat for parent recreation against a running Herdr server.

### Exited-child test race

The failed assertion waited for Focus to draw the exited child's row after the
marker cleared. Herdr 0.9.2-preview keeps that row only until it notices the
exit, about 0.5 to 1 second after the kill. Under All the row disappears at the
same time, so the Focus filter does not hide it. A 1.5-second delay before the
wait reproduced the exact failure 2 of 2 times, and the unmodified test passed
8 of 8 times. The stall in the original full-suite run is not known. Evidence:
`/tmp/piha-sidebar-adversarial-up9g8W/evidence/exit-investigation/REPORT.md`,
`d1-delay1500.out.txt`, and `d2-delay1500.out.txt`.

The test no longer waits for the exited row. It still checks that the marker
retires and the token clears, that a delayed renewal with a lower sequence
number is ignored, and that the replacement occupant is drawn while Focus is
on. Checks in `/tmp/piha-sidebar-adversarial-up9g8W/evidence/follow-exit-fix/`,
each in a fresh namespace sandbox with no ambient Herdr:

- `logs/sidebar-suite`: the edited `sidebar.test.ts`, 8 passed, 0 failed.
- `logs/delayed-gap2000-1` and `logs/delayed-gap2000-2`: a copy of the edited
  test with a 2-second gap after the token clears. Both runs passed 8 of 8.
  After the gap, `agent.list` had no entry for the exited pane and the
  rendered panel had no row for it, so the gap outlasted Herdr's retention.
  `logs/delay-copy.diff` is the only change in the copy.
- Each postflight found no leftover process, lab root, or worktree directory.

### Review triage

All four adversarial reviews have reported: OpenAI `gpt-6-astra`,
DeepSeek 4 Pro, GLM 5.3, and Grok 4.7. The parent triaged their findings:

| Finding | Raised by | Decision | Reason |
| --- | --- | --- | --- |
| Lab shutdown returns silently when ownership is unreadable, does not wait for SIGTERM, and the viewer runs `herdr` from `PATH` | OpenAI | Fixed | sidebar-follow-build-2 fixed it in `herdr-lab.ts` and `sidebar.test.ts`. sidebar-final-review-2 approved it. |
| Exited-child row assertion is racy | Independent verifier | Fixed | See [Exited-child test race](#exited-child-test-race). |
| A suspended original child keeps a reused pane hidden | OpenAI, Grok | Accepted limitation | The user chose the documented workaround over an architecture change. |
| Backward clock after a parent restart | DeepSeek | Documented | Applies only to a new parent on the same Herdr server. A Herdr restart resets sequence state. |
| Generated logs in the package | GLM | No product change | Only the audit snapshot tooling produced them. The original package has 86 entries and no logs (`evidence/original-pack-after-reviews.json`). The last writer added an exact ignore entry and a package regression test. |
| Docs overpromise, and the plugin README links the excluded plan | Grok | Fixed | Docs corrected. |
| TTL message drift, and no ADR for the marker protocol | GLM | Deferred | Revisit with a future protocol change. No ADR now. |
| Duplicate socket client in the plugin and the extension | DeepSeek, GLM | Kept | The plugin must stand alone, and each client runs under a different event-loop owner. |
| The plugin socket should be `unref`'d | DeepSeek | Dismissed | The one-shot client must stay alive until the reply. The timeout destroys the socket, and it is a Unix socket, not TCP. |
| The log sanitizer flattens control characters | DeepSeek | No change | The log line is bounded on purpose. |
| `settleBeforeDeadline` guard looks like dead code | DeepSeek | Kept | The parent showed that an `Atomics.wait` microtask lets a late promise beat an overdue timer, and the guard then rejects it. |
| A liveness bug | Grok | No action | The review gave no evidence for it. The later runtime checks above cover the exit path. |

The `launch.test.ts` PID 1 failure is a sandbox namespace artifact. The test
passed 1 of 1 against the ambient target. This pass did not edit launch tests.

### Closing verification

The failure records above stay as history. Evidence is under
`/tmp/piha-sidebar-final-validate-BoV6bt/evidence/`.

Review: sidebar-final-review-2 (OpenAI, fresh) approved the lab helper and
package fixes with no findings. It ran 23 helper and package tests, 8
ownership tests, 2 portable tests with the Linux shutdown suite skipped under
simulated darwin, and a strict compile of 19 TypeScript files. A simulated
darwin run is not a macOS run.

The full isolated run in `test/REPORT.md` covers a frozen revision. It
predates the last two helper changes, the Linux-only guard and the spawn error
listener:

- Full integration suite: 93 passed, 0 failed, 0 skipped, on the first run.
- Packaged plugin from the extracted tarball: 22 of 22 checks passed. These
  include 3 foreign-owner checks under All and no automatic Focus after a
  restart.
- `npm test` in the sandbox PID namespace: 992 tests, 989 passed, 2 failed,
  1 skipped. One failure is the PID 1 artifact above, which stays unfixed in
  the test. The other was a flaky assertion in `herdr-lab.test.ts`, described
  below. In the host PID namespace, the same frozen revision gave 991 passed
  and 1 skipped.
- Five empty `pi-integ-*` bucket directories stayed under the lab's
  `.herdr/worktrees`, with no files, checkouts, or processes in them. They are
  not attributed to a suite. The full suite left this residue, so it did not
  leave zero filesystem residue.

The flaky assertion checked that the residue message did not contain `lab-a`.
The message also contains the random lab root, and about 2% of roots, such as
`/tmp/piha-herdr-lab-alBAje`, contain `lab-a`. The test now renames its root
to end in `-lab-a` and checks the residue list that follows the exact
`kept <root>: ` prefix. The old check fails against that root, and the new one
passes. Only the test changed. The helper's message format did not change.
Evidence is in `close-fix/`.

The parent's checks on the current revision include both helper changes but
predate the assertion fix:

- Sidebar integration suites in a real PID namespace: 15 passed, 0 failed
  (`parent-current-integration/results/output.log`). Before teardown, the
  only leftovers were the runner's workspace, server, and shell. After
  teardown, no process remained and the lab was removed.
- `npm test`: 994 tests, 993 passed, 0 failed, 1 pre-existing skip for the
  late sidecar (`parent/npmtest-final.log`). Format check, lint, strict
  TypeScript, and LSP passed. The package preview has 86 files: the 3 plugin
  files and no plan, tests, or logs.

After the assertion fix, the parent independently reran the current full unit
suite: 994 tests, 993 passed, 0 failed, and 1 pre-existing skip
(`parent/npmtest-after-close.log`). A separate helper run passed 14 of 14
(`parent/herdr-lab-after-close.log`). Formatting, lint, strict TypeScript,
package inspection, and both repositories' whitespace and root hygiene checks
passed. The package remains version 3.1.0 with 86 files and exactly 3 plugin
files; the plan, tests, and probe logs are excluded.

The fresh closing reviewer, sidebar-close-review (OpenAI), approved the
assertion and evidence-record delta with no findings. It independently passed
14 helper tests and strict TypeScript. It did not reopen the production audit.

The full integration suite was not rerun after the helper changes or the
assertion fix. Remote machines, actual macOS, multiple clients, the live
provider, and a registry install were not run.

The accepted limitation is the suspended original child described above.
OpenAI and Grok confirmed it, and a production-marker stand-in reproduced it in
5 sandbox runs. All, a fresh pane, and the normal host stop controls work around
it. No production fix is planned.

## References

- [Agent view API](https://github.com/herdrdev/herdr/blob/8e78f929d8f0306a5c68518969e90274c44cb1f0/docs/next/website/src/content/docs/socket-api.mdx#L368-L445)
- [Metadata contract](https://github.com/herdrdev/herdr/blob/8e78f929d8f0306a5c68518969e90274c44cb1f0/docs/next/website/src/content/docs/socket-api.mdx#L725-L769)
- [Plugin development](https://github.com/herdrdev/herdr/blob/8e78f929d8f0306a5c68518969e90274c44cb1f0/docs/next/website/src/content/docs/plugins.mdx)
- [Worktree lifecycle](worktree-subagents.md)
- [Upstream workspace visibility request](https://github.com/herdrdev/herdr/discussions/4843)
