# Agreed design constraints for issue 29

These decisions came from the design interview. They are not approval to merge this prototype or bypass validation after #32.

1. **Primary goal:** lower recurring supervision overhead. Faster result delivery is secondary; correct outcome handling is mandatory.
2. **Scale:** target 10 concurrent children; compare 1 and 5 as well. Do not design for unlimited fleets.
3. **Compatibility:** preserve existing launches and a polling fallback. Do not require a companion argv plugin or introduce an additional exit-code file in the first change.
4. **Stop rule:** added machinery must earn its cost with measured benefit. A working prototype is not sufficient by itself.
5. **Performance gate:** at least 80% fewer recurring Herdr CLI launches at 10 children, without regression in total supervision CPU or normal completion-delivery latency. Count actual processes and retain measurement conditions.
6. **Freshness:** no more than five seconds between reconciliation checks while notifications appear healthy; restore the existing polling cadence when the channel is known to be down. This does not bound the duration of a Herdr outage. Reserve scheduling headroom rather than silently relaxing the interval.
7. **Quiet fallback:** transport reconnects must not cause model turns. Expose transport mode diagnostically and preserve meaningful stalled/recovered behavior. Do not suppress normal task results or help requests.
8. **Smallest passing variant:** compare current polling, completion-file wake-ups with reconciliation, and those file wake-ups plus Herdr events. A socket manager is not mandatory if a simpler alternative satisfies the goals.
9. **Rollout:** automatically use the winning mechanism on validated, compatible environments, with polling elsewhere and a diagnostic force-polling option. No normal-user opt-in is required once the gates pass.

## Terminology

**Child wake-up signal:** an internal indication prompting fresh inspection of an owned child. It does not establish completion, failure, or a help request.

**Child result delivery:** the parent-facing handoff of a child run's observed outcome and available evidence. Receiving a result does not establish that the work is correct or accepted.

A Pi lifecycle hook is a local callback, not an automatic cross-process transport. Filesystem and Herdr events can wake the checker. Completion records supply semantic evidence; terminal exit markers are fallback evidence. Human alerts and model-facing results are separate from these internal signals.

## Required contract from #32

Before implementation, bind this design to #32's settled lifecycle:

- Stable agent-instance identity and a dispatched task ID.
- An authoritative per-task completion/failure/help result, distinct from agent lifetime termination.
- A result for task A cannot finish task B or be delivered twice after reconnect/resume.
- Completing a task leaves a persistent agent available; stopping/crashing the agent is a separate event.
- Do not equate the SDK's low-level `turn_end` with dispatched-task completion. Use the settled/completion contract established by #32.

#29 should consume that contract, not introduce a competing result protocol. Retain one-shot-agent regression coverage where those agents remain supported.
