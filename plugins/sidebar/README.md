# Pi Herdr Agents Sidebar

This optional Herdr plugin keeps your main agents easy to find while
[Pi Herdr Agents](../../README.md) runs delegated children. It adds two
actions to Herdr's Agents view:

- **Focus** hides delegated Pi children, except blocked children and children
  whose status is unknown.
- **All** removes Focus if this plugin set it, and then shows every agent
  again. If another tool replaced the view, All leaves that view in place and
  reports which tool owns it.

Neither action closes, moves, or signals anything. Hidden children keep
running, keep their panes, and still raise notifications. `herdr agent list`
still lists them.

## Requirements

- Herdr `0.9.2-preview.2026-09-29-8e78f929d8f0`, the only build the plugin was
  tested on. Herdr accepts only a plain version in `min_herdr_version` and
  reports this preview as `0.9.2`, so the manifest declares `0.9.2`. Herdr
  then also accepts other 0.9.2 builds and newer ones, all untested. A build
  without the agent view API makes Focus and All fail with Herdr's error.
- Linux. The extension identifies child processes through `/proc`, so it marks
  nothing on other systems, and the manifest declares only `linux`.
- `node` on the `PATH` of the Herdr server. Herdr runs the actions as
  `node sidebar.mjs focus` and `node sidebar.mjs all`.
- The `pi-herdr-agents` extension with sidebar markers turned on. Without
  markers, Focus hides nothing.

## Install the plugin

1. Install it from GitHub. Herdr shows the manifest and commands before it
   installs anything:

   ```bash
   herdr plugin install giuseppecrj/pi-herdr-agents/plugins/sidebar
   ```

   To run a local checkout or the copy inside the installed npm package
   instead, link its directory:

   ```bash
   herdr plugin link /path/to/pi-herdr-agents/plugins/sidebar
   ```

2. Turn on markers. Add a `sidebar` section to
   `$PI_CODING_AGENT_DIR/herdr-agents/config.json`
   (default `~/.pi/agent/herdr-agents/config.json`) and keep its other
   sections. If the file does not exist, copy the extension's
   `config.json.example` there first, because the extension rejects a
   `config.json` without its `status` section.

   ```json
   {
     "sidebar": {
       "enabled": true
     }
   }
   ```

3. Run `/reload` in each parent Pi session, or start a new one. Children that
   were already running stay unmarked.

Installing, linking, or enabling the plugin does not turn Focus on.

## Use Focus and All

Run an action from the command line:

```bash
herdr plugin action invoke pi-herdr-agents.sidebar.focus
herdr plugin action invoke pi-herdr-agents.sidebar.all
```

To bind a key, add an entry like this to your Herdr config and pick a key you
do not already use:

```toml
[[keys.command]]
key = "prefix+g"
type = "plugin_action"
command = "pi-herdr-agents.sidebar.focus"
description = "hide delegated Pi children"
```

Herdr keeps one agent view for the whole server. Focus replaces the view that
was active, including a view that another tool set. All sends its clear with
this plugin as the source, so Herdr clears the view only if this plugin owns
it. If another tool replaced Focus, All leaves that view in place and reports
which tool owns it.

Each action writes one message to its log. Read it with
`herdr plugin log list --plugin pi-herdr-agents.sidebar`. The exit status
tells you what happened:

| Exit status | Meaning |
| --- | --- |
| `0` | Focus is on, or All found no view left. |
| `1` | The action failed. Herdr refused the request, sent no usable reply within 3 seconds, or still reports this plugin's view after All. The action also fails when it runs outside Herdr or as another plugin. The message names the cause. |
| `2` | The action name was not `focus` or `all`. |
| `3` | All left another tool's view in place. |

A Herdr server restart drops the view and every marker. The plugin has no
startup hook, so run Focus again after a restart if you want it.

## Remove the plugin

1. Run All, or skip this step. Herdr also drops this plugin's view when you
   disable, unlink, or uninstall the plugin.
2. Remove the plugin. Use `uninstall` for a GitHub install and `unlink` for a
   linked directory:

   ```bash
   herdr plugin uninstall pi-herdr-agents.sidebar
   herdr plugin unlink pi-herdr-agents.sidebar
   ```

3. Set `sidebar.enabled` to `false`, or delete the `sidebar` key, and run
   `/reload` in each parent session. The reload clears the markers of
   children that are still running and stops renewing them. A marker whose
   clear does not reach Herdr expires within 15 seconds.

## Which rows Focus hides

The extension writes the pane token `piha_delegated_v1` with the value `live`
on a delegated child's pane. Focus hides a row only when that token is `live`
and the agent status is `idle`, `working`, or `done`. Focus sends this
filter, with no sort:

```json
{
  "op": "not",
  "filter": {
    "op": "all",
    "filters": [
      { "op": "eq", "field": { "token": "piha_delegated_v1" }, "value": "live" },
      { "op": "in", "field": "status", "values": ["idle", "working", "done"] }
    ]
  }
}
```

| Agent | Marker | Focus |
| --- | --- | --- |
| Main session or manually started agent | none | shown |
| `/worktree` handoff session | none | shown |
| Delegated child: fresh, resumed, persistent, or in a managed worktree | `live` | hidden |
| Delegated child that Herdr reports as blocked | `live` | shown |
| Agent whose status is unknown | any | shown |
| Pane with a missing marker or any other value | missing or other | shown |
| Retained worktree shell after its child exits | cleared | shown |

The `done` status means idle and not yet seen. It does not mean that anyone
accepted the child's work, so Focus hides it like any idle child.

## What a marker proves

A `live` marker means the extension classified the pane's process as a
delegated child within the last 15 seconds. It does not prove that the same
process occupies the pane when Herdr draws the row.

The parent Pi session writes the marker after its child records its own
process identity and the parent verifies it. The parent renews the marker every
4 to 5 seconds while that exact process (PID and start time) is alive. Renewal
runs on the parent's existing supervision checks, so if those checks stall,
the marker expires and the child reappears. The parent clears the marker when
the child finishes, when it stops supervising the child, or when it finds that
process gone or unverifiable. The marker belongs to the pane, not to the process.
Renewal checks only the original process, so a different process in the same
pane can be hidden for as long as the original process stays alive and
supervised. See [Reusing a delegated pane](#reusing-a-delegated-pane).

Each write carries a 15-second time-to-live and a sequence number that
increases across all of a parent's writes. The 15-second guarantee counts from
the last write Herdr accepted. It does not restart when the pane's occupant
changes or the original process is suspended. Herdr ignores a write whose
sequence number is not higher than the last one it applied, so a delayed
renewal cannot undo a clear. The extension does not retry a failed write and
stops writing after three failures in a row.

Some leftover markers still occur:

- If the parent process exits or crashes, its last marker stays until its
  time-to-live ends, up to 15 seconds after the last write Herdr applied.
- A renewal that Herdr processes late starts a new 15-second period, unless a
  clear with a higher sequence number has already arrived.
- A new agent started in the same pane during that window stays hidden by
  Focus until the marker expires.
- If the parent restarts while the same Herdr server keeps running, and the
  system clock has moved backwards, the new parent's sequence numbers can fall
  behind the last ones Herdr applied. Herdr then ignores its writes until the
  clock catches up. A Herdr server restart resets the sequence state and drops
  every marker.

Run All whenever a row you expect is missing. Markers change only what the
Agents view shows. They are not a security boundary.

### Reusing a delegated pane

The marker follows the pane, and the parent keeps renewing it while the
original child process is alive and supervised. A child suspended with Ctrl-Z
is still alive, so if you start another agent in that pane by hand, Focus can
hide the new agent until the original child is stopped or no longer
supervised. Run All before you reuse a delegated pane, or start the new agent
in a fresh pane. To end renewal, stop the child with the host's normal
controls. The last marker then lasts at most 15 seconds after the last write
Herdr accepted. The first version of the plugin has this limitation, and no
fix for pane reuse is planned for it.

## Limits

- Tested only on Linux with the Herdr build named above, one local server, and
  one attached client. Remote machines and several attached clients are
  untested.
- The marker follows the pane, not the process. See
  [Reusing a delegated pane](#reusing-a-delegated-pane).
- Herdr allows at most 32 sequenced metadata sources per pane. The extension
  uses the single source `pi-herdr-agents` for every marker.
- The plugin has no popup, settings, or startup hook, and it does not hide
  workspaces or notifications.
