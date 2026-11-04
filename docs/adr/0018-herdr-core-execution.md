# ADR-0018: Add Herdr Core execution without conflating Desktop placement

- **Status:** Accepted
- **Date:** 2026-11-03
- **Scope:** `giuseppecrj/pi-herdr-agents`
- **Supersedes:** Only ADR-0012's prohibition on a second real surface implementation

## Decision

Keep Pi as the only harness, and support two Herdr execution paths: the legacy
Herdr pane CLI and local Herdr Core terminals. Desktop is a client of Core,
not a third execution backend. Keep one package, explicit runtime composition,
and the existing host/adapter/surface dependency boundaries. Do not add a
provider registry or a plugin-loading architecture.

Select execution from explicit configuration and native session context, not
from the mere presence of an executable or a running Desktop. Automatic
selection must not silently fall back to legacy Herdr when Core is selected
but unavailable. Bind ownership to the selected backend, endpoint and parent
terminal; verify Core's identity before acting on its terminals. Reload must
not redirect a live owner to a different backend or server.

Model Core's atomic process start explicitly. Do not simulate a ready shell,
invent a pane ID before acquiring a terminal, or treat terminal names as
ownership. Prepare local launch artifacts before submission. An uncertain
mutating request must not be retried or advance the model fallback chain.
Report only observed identities, including when a reply was lost.

Keep Pi session files and sidecars as semantic completion evidence. Core
terminal execution state is separate from an agent's reported status and from
whether its retained terminal record exists. Confirm process exit before
releasing lifetime ownership; remove the terminal record as a separate,
delivery-gated operation. Interrupt does not cancel, and a kill request is not
itself confirmation of termination. Suppress Core's automatic child notes so
there is still one host-owned result delivery.

## Staging and limits

The first Core execution milestone covers ordinary children. Core has no native
managed Git worktree API: reject managed worktree entry points before Git,
manifest or terminal acquisition effects until their ownership and cleanup
semantics are implemented. Running an ordinary child in an already-existing
checkout is a different operation and remains allowed.

Desktop Agents tabs and sidebar parity are a separate presentation milestone.
A native parent/child tree is not equivalent to legacy grouped placement or the
legacy Focus/All sidebar. Do not apply the legacy pane-marker protocol to Core
terminals. Do not install a Desktop mod, switch layouts or adopt terminals into
user tabs implicitly.

The locally inspected releases are Core 0.1.17 and Desktop 0.1.12. Desktop's
installed command declarations still provide no `focus: false` directed adoption
of an existing terminal. Its background label adoption enables Core `keep`,
which conflicts with the current non-restoring execution contract. Do not simply
relax ownership checks to permit it. A custom GPUI sidebar/layout can filter its
own rows and compose terminal blocks without adoption, but those blocks are not
native model panes/tabs. `setAgentOrder` orders agents; it does not exclude them
from native navigation. These are design alternatives, not implemented parity.
Pixel parity requires real, isolated rendering and reference-image comparison;
API documentation or a successful Core launch is not visual acceptance.

## Consequences

Legacy behavior remains governed by its existing placement, worktree and
cleanup contracts. Core execution gets its own bounded transport and process
lifecycle implementation under `maestro/surfaces/herdr/`; shared Pi policy and
result protocols stay in the Pi adapter and runtime.

Test both implementations with unit evidence, then exercise the Core path
through a real parent Pi and the public tools in an isolated local server.
Use a fresh HOME, XDG directories, Core session and socket, plus a local
credential-free provider. Never use the operator's daily Core/Desktop instance
as a test fixture. Desktop tests additionally need an isolated application
home and executable/update destination; application state isolation alone does
not isolate keyboard focus on the operator's display.

The remaining decisions in [ADR-0012](0012-adopt-maestro-seams-in-repo.md),
[ADR-0014](0014-operator-cancel-terminal-intent.md), and the
[worktree contract](../worktree-subagents.md) remain in force. This ADR records
the architecture and safety boundary, not completion of all migration stages.
