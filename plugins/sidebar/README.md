# Pi Herdr Agents Sidebar

![Pi Herdr Agents: a parent Pi session delegating to parallel child agents in dedicated Herdr panes, an isolated worktree and a retained session, with a live status widget.](https://raw.githubusercontent.com/giuseppecrj/pi-herdr-agents/main/docs/assets/pi-herdr-agents-gallery.png)

> **Compatibility.** The npm release `pi-herdr-agents@3.1.0` predates sidebar support. Use a local checkout that contains this plugin and the `sidebar.enabled` setting, or a later release that includes both.

An optional [Herdr](https://herdr.dev) plugin for [Pi Herdr Agents](../../README.md). It keeps your main agents easy to find in Herdr's Agents view while [Pi](https://github.com/earendil-works/pi) runs delegated children.

The plugin adds two actions. The extension in the main package marks each delegated child's pane, and Focus hides the marked rows.

## Features

- **Focus.** Hides delegated Pi children from the Agents view, except blocked children and children whose status is unknown.
- **All.** Removes Focus if this plugin set it, then shows every agent again. If another tool replaced the view, All leaves that view in place and reports which tool owns it.
- **Display only.** Neither action closes, moves, or signals anything. Hidden children keep running, keep their panes, and still raise notifications. `herdr agent list` still lists them.
- **No automatic Focus.** Installing, linking, or enabling the plugin never turns Focus on. You invoke it.
- **Opt-in markers.** The extension writes pane markers only when you set `sidebar.enabled` to `true`.

## Requirements

- Herdr `0.9.2-preview.2026-09-29-8e78f929d8f0`, the only build the plugin was tested on. Herdr accepts only a plain version in `min_herdr_version` and reports this preview as `0.9.2`, so the manifest declares `0.9.2`. Herdr then also accepts other 0.9.2 builds and newer ones, all untested. A build without the agent view API makes Focus and All fail with Herdr's error.
- Linux. The extension identifies child processes through `/proc`, so it marks nothing on other systems, and the manifest declares only `linux`.
- `node` on the `PATH` of the Herdr server. Herdr runs the actions as `node sidebar.mjs focus` and `node sidebar.mjs all`.
- The `pi-herdr-agents` extension, installed in Pi from a revision that supports `sidebar.enabled`, with that setting turned on. Without markers, Focus hides nothing.

## Install

Setup has two parts. Install the Herdr plugin, then enable markers in a compatible Pi extension. The plugin alone hides nothing, and the setting alone adds no actions.

### 1. Install the Herdr plugin

Review the plugin source, then link its directory from your local checkout:

```bash
herdr plugin link /path/to/pi-herdr-agents/plugins/sidebar
```

Once the GitHub default branch contains `plugins/sidebar`, you can install the subdirectory instead. Herdr shows the manifest and commands for review:

```bash
herdr plugin install giuseppecrj/pi-herdr-agents/plugins/sidebar
```

For another published branch, tag, or commit, add `--ref` followed by that revision. The revision must contain the plugin directory.

### 2. Turn on markers in the Pi extension

The Pi extension must also contain sidebar support. If you do not already load a compatible copy, install the same local checkout in Pi:

```bash
pi install /path/to/pi-herdr-agents
```

Use `pi list` to check your existing package sources. If another copy of Pi Herdr Agents is enabled, disable that copy with `pi config` before loading the checkout. Do not load both copies. Start Pi inside Herdr.

1. Open `$PI_CODING_AGENT_DIR/herdr-agents/config.json`. The default is `~/.pi/agent/herdr-agents/config.json`.
2. If the file does not exist, copy `config.json.example` from the extension there first. The extension rejects a `config.json` without its `status` section.
3. Merge the `sidebar` section into the file. Keep the existing `status`, `models`, and other sections. Do not replace the file.

   ```json
   {
     "sidebar": {
       "enabled": true
     }
   }
   ```

4. Run `/reload` in each parent Pi session, or start a new one.
5. Launch new children. Children that were already running stay unmarked.
6. Invoke Focus yourself. See [Use Focus and All](#use-focus-and-all).

### Check the result

After you launch a new child and run Focus, a marked child with status `idle`, `working`, or `done` disappears from the Agents view while your main session stays. Blocked children remain visible. Run All to show the hidden row again. If nothing changes, read the action log:

```bash
herdr plugin log list --plugin pi-herdr-agents.sidebar
```

## Contents

- [Requirements](#requirements), [Install](#install), [Use Focus and All](#use-focus-and-all)
- [Troubleshooting](#troubleshooting), [Safety](#safety), [Uninstall](#uninstall)
- [Which rows Focus hides](#which-rows-focus-hides), [What a marker proves](#what-a-marker-proves), [Reusing a delegated pane](#reusing-a-delegated-pane), [Limits](#limits)
- Main package: [Pi Herdr Agents](../../README.md) and its [sidebar markers](../../README.md#sidebar-markers) setting

## Use Focus and All

Run an action from the command line:

```bash
herdr plugin action invoke pi-herdr-agents.sidebar.focus
herdr plugin action invoke pi-herdr-agents.sidebar.all
```

To bind a key, add an entry like this to your Herdr config and pick a key you do not already use:

```toml
[[keys.command]]
key = "prefix+g"
type = "plugin_action"
command = "pi-herdr-agents.sidebar.focus"
description = "hide delegated Pi children"
```

Herdr keeps one agent view for the whole server. Focus replaces the view that was active, including a view that another tool set. All sends its clear with this plugin as the source, so Herdr clears the view only if this plugin owns it. If another tool replaced Focus, All leaves that view in place and reports which tool owns it.

Each action writes one message to its log. Read it with `herdr plugin log list --plugin pi-herdr-agents.sidebar`. The exit status tells you what happened:

| Exit status | Meaning |
| --- | --- |
| `0` | Focus is on, or All found no view left. |
| `1` | The action failed. Herdr refused the request, sent no usable reply within 3 seconds, or still reports this plugin's view after All. The action also fails when it runs outside Herdr or as another plugin. The message names the cause. |
| `2` | The action name was not `focus` or `all`. |
| `3` | All left another tool's view in place. |

A Herdr server restart drops the view and every marker. The plugin has no startup hook, so run Focus again after a restart if you want it.

## Troubleshooting

- **A child you expect to be hidden is still visible.** Check that `sidebar.enabled` is `true`, that you ran `/reload` in the parent, and that the child was launched after the reload. Then run Focus again. A blocked child or a child with unknown status is always shown.
- **A row you expect is missing.** Run All. Markers change only what the Agents view shows.
- **Focus or All exits with status `1`.** Read the log with the command above. The message names the cause, such as a Herdr build without the agent view API.
- **All exits with status `3`.** Another tool owns the view. All leaves it in place.
- **A new agent in a delegated pane is hidden.** See [Reusing a delegated pane](#reusing-a-delegated-pane).

## Safety

- Markers are display only. They are not a security boundary.
- The plugin sends requests to your local Herdr server. It does not close, move, or signal panes.
- With `sidebar.enabled` on, the parent records each child's process identity and reports one pane token, `piha_delegated_v1`, through the Herdr socket. With it off, the extension writes no pane metadata. See [Safety and uninstall](../../README.md#safety-and-uninstall) in the main README.

## Uninstall

1. Run All, or skip this step. Herdr also drops this plugin's view when you disable, unlink, or uninstall the plugin.
2. Remove the plugin. Use `uninstall` for a GitHub install and `unlink` for a linked directory:

   ```bash
   herdr plugin uninstall pi-herdr-agents.sidebar
   herdr plugin unlink pi-herdr-agents.sidebar
   ```

3. Set `sidebar.enabled` to `false`, or delete the `sidebar` key, and run `/reload` in each parent session. The reload clears the markers of children that are still running and stops renewing them. A marker whose clear does not reach Herdr expires within 15 seconds.

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
