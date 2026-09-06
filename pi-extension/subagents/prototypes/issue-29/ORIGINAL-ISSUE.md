# Historical original proposal

Preserved as provenance before the prototype handoff update. Its performance and lifecycle claims are superseded by HANDOFF.md and REPORT.md. Do not use it as an implementation contract.

## Summary

`pi-herdr-agents` learns that a child finished, crashed, or vanished by **asking on a schedule**: background ticks read the child's activity snapshot and shell out to `herdr pane get` per running child (`inspectPane` → `execFileAsync("herdr", …)`), and the watchdog promotes unhealthy inspection to `stalled` after `SNAPSHOT_STALLED_AFTER_MS` (60s).

herdr already ships the push channel this architecture wants: a persistent ndJSON unix-socket API (`events.subscribe`) that emits `pane.exited` / `pane.closed` **the moment they happen**, with the socket path injected into every pane (`HERDR_SOCKET_PATH`). Subscribing to it would make completion and death detection event-driven — millisecond latency, zero per-tick CLI spawns, an explicitly bounded reconnect gap — while the existing poll is **demoted to a fallback/reconcile path**, so behavior degrades to exactly today's when the socket is unavailable.

The design is patterned on [`modem-dev/pi-herdr-subagents`](https://github.com/modem-dev/pi-herdr-subagents) (a herdr-native descendant of HazAT's `pi-interactive-subagents`, MIT), whose project brief documents the two failure classes that motivate it: launch races from typing into shells, and **a dead child looking like a screen that stopped changing**.

## What happens today (as I read the source)

```mermaid
sequenceDiagram
    participant C as Child pi (pane w1:p4)
    participant H as herdr server
    participant P as Parent extension
    Note over C: child exits / crashes / pane closed
    loop every tick (widget 1s, activity 500ms)
        P->>H: herdr pane get (fresh CLI process per child)
        H-->>P: pane state / missing
    end
    Note over P: death discovered on a later tick;<br/>unhealthy reads accumulate toward stalled (60s)
```

```text
startStatusRefresh
  setInterval(→ for each running child)
    readSubagentActivityFile            # local fs — cheap
    inspectPane → execFileAsync("herdr", ["pane","get",…])   # a process spawn per child per inspection
  projectLifecycle → maybe steer
```

Costs and gaps of the poll-shaped design:

1. **Latency is bounded by ticks, not by truth.** Completion wake-up and crash detection wait for the next inspection; a hard-killed child (OOM, `kill -9`, user closes the pane) is noticed when a later `pane get` returns `missing`, and a degraded herdr CLI silently erodes toward the 60s watchdog instead of signaling anything.
2. **Each inspection is a process spawn.** With N parallel children and ~1s refresh, that's on the order of N `herdr` fork/execs per second, forever, on the parent's event loop. Fine at N=2, wasteful at N=10, and it competes with the TUI on modest hardware.
3. **herdr *unavailability* and child *unhealthiness* look identical** from where the poll sits — both surface as inspection failure feeding the stalled projection.
4. **The watchdog is the only net under missed transitions.** It works, but a minute-long worst case to learn a child died is a design artifact of polling, not a necessity — the information existed in the socket the whole time.

## Proposal (phased, additive)

### Phase 1 — event-driven detection, poll as reconcile/fallback

One global `HerdrEventStream`: a persistent ndJSON connection over `HERDR_SOCKET_PATH`, subscribing once to `pane.exited` + `pane.closed`, dispatching locally to per-pane listeners. Verified wire protocol (per modem-dev's source, against herdr 0.7.1):

```text
→ {"id":"sub1","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.exited"},{"type":"pane.closed"}]}}
← {"id":"sub1","result":{"type":"subscription_started"}}
← {"event":"pane_exited","data":{"pane_id":"w1:p4","workspace_id":"w1", …}}
```

Three-channel watcher — first signal wins, latecomers no-op, **every path terminates the watch (no eternal-stall zombie)**:

```text
watch(child):
  events.watch(child.paneId, ev → resolve)         # (a) primary: pushed death/exit, ms
  fs.watch(sessionDir) on sidecars → resolve       # (b) fallback: covers pane-still-alive child-death
  onReconcile(→ if !paneExists resolve)            # (c) closes the gap: events.subscribe has NO replay,
                                                   #     so anything missed before a resubscribe is
                                                   #     reconciled by existence check, not by timeout
  slow poll (today's behavior)                     # last resort only
resolve(): idempotent; sidecars consumed on read so a resume can't see stale signals
```

Reconnect uses short backoff (e.g. 500ms → 5s); after each successful re-subscribe the reconcile hook fires once and per-child existence is checked — turning "we might have missed an event" from an unbounded worry into a bounded, explicit ms-scale window.

```mermaid
sequenceDiagram
    participant C as Child pi
    participant H as herdr server
    participant S as HerdrEventStream (one socket)
    participant P as Parent extension
    P->>H: events.subscribe {pane.exited, pane.closed}
    H-->>S: subscription_started
    C-->>H: process exits
    H--)S: pane_exited {pane_id: w1:p4}
    S--)P: per-pane listener → resolve watch in ms
    Note over P: sidecar still supplies summary/exit evidence;<br/>poll survives only as reconcile + last-resort
```

```diff
 startStatusRefresh
   setInterval(→ per child)
     readSubagentActivityFile             # unchanged
-    inspectPane → execFileAsync("herdr", …)   # per-child spawn, latency floor
+    inspectPane                          # demoted: reconcile + last-resort fallback
+ HerdrEventStream                        # NEW: one socket, all children
+   events.subscribe(pane.exited, pane.closed)
+   watch(child.paneId) → resolve → deliver
```

**Compatibility:** feature-detect on `HERDR_SOCKET_PATH`. Missing socket, subscription failure, or an older herdr → the stream never comes up and behavior is byte-for-byte today's. Nothing about the public tool contract changes.

### Phase 2 — exit-code sidecar

`pane_exited` deliberately carries no exit code. A tiny wrapper around the child command writing `<sessionFile>.exitcode` closes that (modem-dev verified this gap the hard way). The repo already has sidecar infrastructure (`consumeExitSidecar`), so this slots into the existing evidence chain: sidecar first, exit marker fallback — events become the *trigger*, sidecars remain the *evidence*.

### Phase 3 (optional, separately) — argv plugin-pane launch

The same project eliminates the launch race entirely: `herdr plugin pane open --entrypoint argv --env PI_HERDR_LAUNCH_SCRIPT=…` has herdr itself `exec` the generated launch script — no interactive shell is ever typed into, so a direnv/slow-rc shell can't swallow the launch, by construction. This one does imply a plugin dependency and a herdr ≥ 0.8.2 floor plus a `plugin link` setup step, so I'd treat it as its own decision — possibly ADR-worthy — rather than bundling it here.

## Why this belongs in this repo

- **It makes the internals match the package's own contract.** AGENTS.md: *"The extension is fire-and-forget… completion is delivered to the parent automatically. Never add polling guidance."* The external promise is already push-shaped; today the internal machinery gets there by ticking. Events deliver on the promise literally.
- **It strengthens, not replaces, the evidence chain.** CONTEXT.md: *"completion uses Pi sidecar evidence first and the terminal exit marker as fallback."* Events become a fast *trigger*; sidecar evidence and semantics are untouched. The stalled watchdog stays as the final net — it just stops being the primary death detector.
- **Scale economics for the orchestration story.** The package's pitch is parallel scouts/workers/reviewers. Event-driven detection makes 10 children cost one socket, not ten CLI spawns per second — and shrinks parent wake-up latency for tight scout → orchestrate loops from tick-scale to milliseconds.
- **Recovery gets sharper.** "Watchers survive `/reload`…" is already a strength; the reconcile-on-resubscribe pattern gives the same rigor to socket-level continuity, instead of the watchdog timeout being the only thing standing between a missed event and a confused parent.

## What I'd verify before merging

- `pane.exited`/`pane.closed` semantics across herdr 0.7.x → 0.8.2 (payload shape, ordering vs. sidecar writes)
- Behavior when the herdr server restarts under an open subscription (reconnect + reconcile)
- That a `pane.exited` arriving *before* the child's completion sidecar is written resolves only via the sidecar path (correct summary, correct `caller_ping` handling)
- Interactive (user-driven) children: events resolve the watch, but stall/steer suppression rules stay as-is

Happy to implement Phase 1 + 2 behind feature detection and run the full verification per AGENTS.md (`npm test`, `npm run format:check`, `npm run lint`, deterministic `npm run test:integration` from inside herdr, LSP diagnostics on changed files), plus the README lifecycle-section sync.

## Credit & references

- [`modem-dev/pi-herdr-subagents`](https://github.com/modem-dev/pi-herdr-subagents) — `src/herdr/events.ts` (HerdrEventStream), `src/watcher.ts` (three-channel watcher, "no path to an eternal stalled zombie"), `herdr-plugin/` (argv entrypoint), `docs/PROJECT-BRIEF.md` (the war story)
- [`HazAT/pi-interactive-subagents`](https://github.com/HazAT/pi-interactive-subagents) — the orchestration model this whole family descends from
