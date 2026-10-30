# Cancel and interrupt

`subagent_cancel({ id | name })` ends one ordinary running child. It records the cancel intent first, closes the ordinary pane, never advances to a fallback model, and delivers exactly one cancelled `subagent_result`. `subagent_interrupt({ id | name })` only sends Escape to the child's active turn; the pane, session and watcher stay alive and nothing is delivered for the interrupt itself.

## Sub-features

- `cancel-confirmed`: the cancel tool result reports `status: "confirmed"` and says the pane was closed.
- `cancel-one-result`: exactly one `subagent_result` with `details.error: "cancelled"` and a `cancellation` record, whose text says it was cancelled by the parent with no model fallback, retry or recovery.
- `cancel-no-fallback`: `provider-requests.json` has no request for `fallback-secondary` after the cancel.
- `cancel-persistent-rejected`: cancelling a persistent specialist is refused, with a pointer to `subagent_stop`.
- `interrupt-turn`: the child is labelled `interrupted` and stays open.

## How to get to it (user POV)

- The parent's model calls `subagent_cancel` or `subagent_interrupt` with the running child's id or exact name (docs/tools.md, "Cancelling a running subagent" and "Interrupting a running subagent").

## Driving it with lab.ts

Preconditions:

- `$L up` printed `LAB_READY`. Covered by `test/integration/subagent-cancel.test.ts`: "(a) cancels a slow ordinary child: one cancelled result, pane closed, no fallback", "(d) rejects cancel of a persistent specialist and points to subagent_stop" and "(e) double cancel is idempotent: one result, no error, no fallback".

- **Launch a slow child.** Run `$L prompt cancel c1`. The parent launches `Cancel-c1`, whose bash step writes `start.txt` in the marker dir and then sleeps about 91 s. The helper prints `MARKER_DIR <dir>`: a fresh 0700 directory under the private lab root. Call it `$M` below. Reusing an id in one run is refused.
- **Prove it is running.** Wait for `$M/start.txt` to contain `START_c1`, and for the pane timeline to show the child pane.
- **Cancel.** Open the gate with `touch "$M/gate.txt"`. The scripted parent then calls `subagent_cancel({ name: "Cancel-c1" })`.
- **Proof.** Wait for one `subagent_result` entry, then run `$L evidence cancel`. `verdict.json` must show `error: "cancelled"` for `Cancel-c1` and `panesOtherThanParent: 0`. `$M/start.txt.done` must not exist, and `provider-requests.json` must have no `fallback-secondary` model.
- **Clean.** Nothing to do: the marker dir lives inside the lab root, and `$L down` removes it. Never use predictable `/tmp` marker paths; another user's symlink or a leftover gate would break the proof.

## Gotchas

- `subagent_interrupt` has no deterministic driver: `fake-provider.ts` never emits it, and no integration test calls the tool. Interrupt coverage is unit-level (`test/test.ts`: "interrupts only the turn and keeps process runtime open", "cancels an interrupted child") plus `test/integration/mux-surface.test.ts` "delivers Escape as byte 27 to the target surface". Report `interrupt-turn` as unverified by the lab unless you drive it with a live model (`PI_TEST_LIVE=1` is the suite's live switch; the lab always uses the deterministic provider).
- The gate exists so the cancel happens while the child is provably mid-command. Without it, cancel races launch and can return `requested`.
- Closing the child pane by hand is not a cancel. It starts the fallback model (negative control "(b) negative control: closing the pane by hand starts the fallback model").
