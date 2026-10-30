# Launch and result delivery

A parent calls `subagent`, gets an immediate acknowledgement, the child runs in its own Herdr pane, and on exit the result arrives in the parent as one `subagent_result` steer message. The child's text is inside `<subagent_report from="<name>" kind="result">` and the host lines are outside it. The parent then continues, and the child pane is closed after delivery is accepted.

## Sub-features

- `launch-ack`: `subagent` returns at once with `Sub-agent "<name>" launched and is now running in the background`.
- `launch-pane`: the child gets a pane in an extension-owned `Agents` tab of the caller's workspace.
- `deliver-envelope`: exactly one `subagent_result`. The child text is inside the envelope; the head line `Sub-agent "<name>" completed (...)`, the session reference and `Parent action: ...` are outside it.
- `deliver-continue`: the parent produces an assistant turn after the delivery, with no extra user message.
- `release-pane`: the child pane is gone after delivery; the child session file stays.

## How to get to it (user POV)

- The model calls the `subagent` tool with `name`, `agent` and `task` (docs/tools.md, "Spawning Subagents").
- A human types `/subagent <agent> <task>` in the parent Pi (`/subagent list` lists roles; registered in `pi-extension/subagents/launch-tools.ts`). It launches without a model turn, so `$L send "/subagent test-echo Return exactly CMD_RESULT_x"` should be drivable on the deterministic provider; this entry has not been proved in the lab yet.

## Driving it with lab.ts

Preconditions:

- `$L up` printed `LAB_READY`. Covered in CI-free form by `test/integration/subagent-lifecycle.test.ts`: "spawns a subagent that writes a file and verifies the session" and "delivers one model-visible custom completion message".

- **Launch.** Run `$L prompt launch d1`. It prints `SENT launch id=d1`. Within seconds `$L read 60` shows the launch acknowledgement for `Echo-d1`.
- **Child pane.** `<run>/pane-timeline.jsonl` gains an entry with a second pane in a new tab. The child exits after one turn, so `$L panes` may already have missed it; the timeline is the record.
- **Delivery.** Wait until the parent session holds the result: `until grep -q '"customType":"subagent_result"' "$(node -p 'require(process.argv[1]).parentSession' "$(cat /tmp/verify-pi-herdr-agents/current)/state.json")"; do sleep 1; done` (bound it with `timeout 120`).
- **Proof.** Run `$L evidence launch`. `verdict.json` must show `envelopeFrom: "Echo-d1"`, `envelopeKind: "result"`, `headOutsideEnvelope: true`, `childSessionExists: true`, `parentContinued: true` and `panesOtherThanParent: 0`. `delivered.txt` must contain `CHILD_RESULT_d1` between `<subagent_report from="Echo-d1" kind="result">` and `</subagent_report>`, with `Parent action:` after the closing tag.

## Gotchas

- The deterministic parent says `PARENT_CONTINUED_<id>` right after the launch acknowledgement and again after the delivery. The screen text alone does not prove delivery; the `subagent_result` entry does.
- Release is delivery-gated: the pane closes only after the parent accepted the message. Capture evidence after the entry appears, or `panesOtherThanParent` can still be 1.
- The deterministic parent also calls `subagents_list` first, because the request text mentions that tool. The screen shows `No subagent definitions found.` before the launch. This is expected, not a failure.
- `test-echo` has `auto-exit: true`. A role without it keeps the child alive and nothing is delivered until it calls `subagent_done`.
- The prompt must keep `name: "..."`, `agent: "..."` and `task: "..."` in that quoted form. `fake-provider.ts` (`subagentCalls`) parses exactly that.
