# Help request (caller_ping)

A Pi-backed child calls `caller_ping({ message })` to ask its parent for help. An ordinary child exits, and the parent receives a `subagent_ping` steer whose head reads `Sub-agent <name> needs help`, followed by the message inside `<subagent_report from="<name>" kind="help-request">`. The parent can continue the child with `subagent_resume({ sessionPath, message })`.

## Sub-features

- `ping-deliver`: one `subagent_ping` custom message with `kind="help-request"` and the child's message in the body; it has no `Parent action:` continuation line.
- `ping-exit`: the ordinary child exits and its pane is released; the child session file is kept for resume.
- `ping-resume`: `subagent_resume` with the child session path opens a new ordinary pane on the same session.

## How to get to it (user POV)

- A child's model calls `caller_ping` (child-only tool; docs/tools.md, section "caller_ping", Child-to-Parent Help Request).
- The parent's model calls `subagent_resume` with the `Session:` path from the ping.

## Driving it with lab.ts

Preconditions:

- `$L up` printed `LAB_READY`. Covered by `test/integration/subagent-lifecycle.test.ts`: "subagent caller_ping sends notification back to the parent". Resume is covered by "preserves restricted child tools and spawning denial across public resume".

- **Launch the pinging child.** Run `$L prompt ping p1`. The parent launches `Ping-p1` with role `test-ping`, which always calls `caller_ping` with `PING: integration`.
- **Help request.** Wait until the parent session holds `"customType":"subagent_ping"`. `$L read 80` shows `needs help`.
- **Proof.** Run `$L evidence ping`. `verdict.json` must show `customType: "subagent_ping"`, `envelopeFrom: "Ping-p1"` and `envelopeKind: "help-request"`. `delivered.txt` must show `PING: integration` inside the block.
- **Resume.** Copy the child session path from `delivered.txt` and run `$L send 'Call the subagent_resume tool with sessionPath: "<path>" name: "Resume-p1" message: "RESUME_FOLLOWUP_INPUT: p1"'`. A new pane appears in the timeline, and a second delivery from `Resume-p1` carries `RESUME_RESULT_p1`.

## Gotchas

- `caller_ping` is not registered in a standalone Pi. Calling it from the parent errors, so only a child can drive this path.
- The provider sends `caller_ping` only when the child's prompt asks for it. The `test-ping` role body does that; a `test-echo` child never pings.
- A persistent specialist's ping keeps the session alive, and the reply goes through `subagent_send`, not resume (see `persistent-specialist.md`).
- Resume of a managed-worktree child session is rejected by design. Use the retained workspace.
