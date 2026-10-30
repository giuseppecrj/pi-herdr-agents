# Persistent specialist

`subagent` with `persistent: true` creates one long-lived specialist with a launch-time policy snapshot. Each task, the initial one and each `subagent_send({ id|name, message })`, is delivered exactly once as a `task-result`. A send while the specialist is busy is rejected (`rejected-busy`) and never queued. `subagent_stop` ends it gracefully and reports `stopped` only after process-exit evidence, then closes the ordinary pane.

## Sub-features

- `ps-task1`: the first task's result arrives once as a `subagent_result` with a task ID (`kind="task-result"`), and the specialist stays alive.
- `ps-busy`: a `subagent_send` during task 1 is rejected and its text never executes.
- `ps-list`: `subagents_list` shows the specialist with its completed-task count.
- `ps-task2`: a follow-up `subagent_send` runs and is delivered once.
- `ps-stop`: `subagent_stop` yields `Persistent specialist stopped.`, the pane closes and the name is released.
- `ps-cancel-rejected`: `subagent_cancel` on it is refused with a pointer to `subagent_stop` (see `cancel-and-interrupt.md`).

## How to get to it (user POV)

- The parent's model calls `subagent` with `persistent: true`, then `subagent_send`, `subagents_list` and `subagent_stop` (docs/tools.md, "Persistent specialists").

## Driving it with lab.ts

Preconditions:

- `$L up` printed `LAB_READY`. Covered by `test/integration/persistent-specialist.test.ts`: "delivers sequential tasks, rejects busy work, and stops cleanly"; the stop path is also in `test/integration/harness-conformance.test.ts` "real persistent task outcome keeps Pi alive and saved policy refuses resume".

- **Start.** Run `$L prompt persistent s1`. The scripted parent launches `Persistent-s1` (role `test-echo`). The child writes `PERSISTENT_START_s1` to `persistent.txt` in the marker dir the helper prints as `MARKER_DIR` (inside the private lab root), sleeps 5 s, then appends `PERSISTENT_DONE_s1`.
- **Busy rejection.** While the file has START but not DONE, the parent has already sent `REJECTED_TASK_s1 must never execute`. `$L read 120` shows the rejection, and the child session never contains `REJECTED_TASK_s1` as executed work.
- **Task results.** Wait for two `subagent_result` entries named `Persistent-s1`: one carrying `PERSISTENT_TASK_1_RESULT_s1` and one carrying `PERSISTENT_TASK_2_RESULT_s1`.
- **Stop.** The script then calls `subagent_stop` and `subagents_list`, and the parent finally says `PERSISTENT_LIFECYCLE_COMPLETE_s1`.
- **Proof.** Run `$L evidence persistent`. `verdict.json` must show two deliveries from `Persistent-s1` with `envelopeKind: "task-result"` and, after stop, `panesOtherThanParent: 0`.

## Gotchas

- The whole lifecycle is scripted by `persistentSpecialistResponse` in `fake-provider.ts`, keyed on `INTEGRATION_PERSISTENT_SPECIALIST:<id>`. Typing `subagent_send` by hand does nothing on the deterministic provider.
- Task 2 is sent about 2 s after task 1 completes, so the one-second lifecycle poll sees `idle` first. Allow about 30 s for the full run.
- Persistent sessions cannot be resumed in v1. A crash yields one facts-only notice; spawn a new specialist.
