# Pi Herdr Agents Sidebar

![Pi Herdr Agents: a parent Pi session delegating to parallel child agents in dedicated Herdr panes, an isolated worktree and a retained session, with a live status widget.](https://raw.githubusercontent.com/giuseppecrj/pi-herdr-agents/main/docs/assets/pi-herdr-agents-gallery.png)

> **Compatibility.** Releases of `pi-herdr-agents` newer than `3.3.1` mark children with no setting. Releases `3.2.0` through `3.3.1` mark them only with `"sidebar": { "enabled": true }` in their `config.json`. On macOS, sidebar support requires a release newer than `3.2.1`.

An optional [Herdr](https://herdr.dev) plugin for [Pi Herdr Agents](../../README.md). It keeps your main agents easy to find in Herdr's Agents view while [Pi](https://github.com/earendil-works/pi) runs delegated children.

The plugin adds two actions and two hooks. The extension in the main package marks each delegated child's pane, and Focus hides the marked rows. Focus is on by default.

## Features

- **Focus.** Hides delegated Pi children from the Agents view, except blocked children and children whose status is unknown.
- **All.** Removes Focus if this plugin set it, then shows every agent again. If another tool replaced the view, All leaves that view in place and reports which tool owns it.
- **Display only.** Neither action closes, moves, or signals anything. Hidden children keep running, keep their panes, and still raise notifications. `herdr agent list` still lists them.
- **Focus is on by default.** You do not run it. Herdr has no install hook, so Focus turns on at the first agent Herdr detects after install. Hooks apply it again after a Herdr server restart and whenever Herdr detects an agent.
- **All sticks.** Run All to turn Focus off. The plugin remembers that choice, and the hooks then leave the Agents view alone until you run Focus again.
- **No setting.** The extension always marks delegated children's panes inside Herdr. Install this plugin to use the markers, or uninstall it to ignore them.

## Requirements

- Herdr `0.9.0` or later. `0.9.0` is the first release with `agent.view.set` and `agent.view.clear`, the only Herdr methods the actions call, so the manifest declares `min_herdr_version = "0.9.0"`. The plugin was tested on `0.9.1`, `0.9.2-preview.2026-09-29-8e78f929d8f0`, and `0.9.5`; other builds are untested. A build without the agent view API makes Focus and All fail with Herdr's error.
- Linux or macOS. The manifest declares `linux` and `macos`. Windows is untested and not declared.
- `node` on the `PATH` of the Herdr server. Herdr runs `node sidebar.mjs focus`, `all`, and `restore`.
- A `pi-herdr-agents` extension release newer than `3.3.1`. Without markers, Focus hides nothing. See the compatibility note above for older releases.
- Herdr's Pi integration, installed in the Pi agent directory your parent and children use. The extension marks a child only while Herdr reports that child's own session file for its pane, and Herdr learns it from this integration. Check for `herdr-agent-state.ts` in `$PI_CODING_AGENT_DIR/extensions/`, or install it with `herdr integration install pi`.

## Install

Install the Herdr plugin, and make sure Pi loads a compatible extension. The plugin alone hides nothing, because the extension writes the markers.

### 1. Install the Herdr plugin

Install the plugin from GitHub. Herdr shows the manifest and commands for review:

```bash
herdr plugin install giuseppecrj/pi-herdr-agents/plugins/sidebar
```

For another published branch, tag, or commit, add `--ref` followed by that revision. The revision must contain the plugin directory.

### 2. Load a compatible Pi extension

If Herdr's Pi integration is not installed yet, install it. It reports each Pi session to Herdr:

```bash
herdr integration install pi
```

If you do not already load a `pi-herdr-agents` release newer than `3.3.1`, install the latest npm release in Pi:

```bash
pi install npm:pi-herdr-agents
```

Use `pi list` to check your existing package sources. If a copy from another source is enabled, disable that copy with `pi config` before loading the npm package. Do not load both copies. Start Pi inside Herdr.

1. After installing or upgrading the extension, run `/reload` in each parent Pi session, or start a new one.
2. Launch new children. Running children that were never marked are not marked retroactively.
3. Start or wait for an agent. Focus turns on at the first agent Herdr detects. To change it, see [Use Focus and All](#use-focus-and-all).

### Check the result

After you launch a new child, a marked child with status `idle`, `working`, or `done` disappears from the Agents view while your main session stays. Blocked children remain visible. Run All to show the hidden row again. If nothing changes, read the action log:

```bash
herdr plugin log list --plugin pi-herdr-agents.sidebar
```

Then check the child's pane. It should report the child's session file as `agent_session` and carry the `piha_delegated_v1` token:

```bash
herdr pane get <child-pane-id>
```

## Contents

- [Requirements](#requirements), [Install](#install), [Use Focus and All](#use-focus-and-all)
- [Troubleshooting](#troubleshooting), [Safety](#safety), [Uninstall](#uninstall)
- [Which rows Focus hides](#which-rows-focus-hides), [What a marker proves](#what-a-marker-proves), [Reusing a delegated pane](#reusing-a-delegated-pane), [Limits](#limits)
- Main package: [Pi Herdr Agents](../../README.md) and its [sidebar markers](../../docs/configuration.md#sidebar-markers)

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

Focus is on by default. Run an action to change it. Your last choice is saved in `view.json` in the plugin's state directory, and a missing or unreadable file means Focus.

Herdr keeps one agent view for the whole server. Because of that, the hooks replace another tool's view whenever Herdr detects an agent, unless you chose All. Focus replaces the view that was active, including a view that another tool set. All sends its clear with this plugin as the source, so Herdr clears the view only if this plugin owns it. If another tool replaced Focus, All leaves that view in place and reports which tool owns it.

Each action writes one message to its log. Read it with `herdr plugin log list --plugin pi-herdr-agents.sidebar`. The exit status tells you what happened:

| Exit status | Meaning |
| --- | --- |
| `0` | Focus is on, All found no view left, or `restore` did its job. `restore` is the hook mode. It applies Focus, or does nothing if you chose All. It never saves a choice. |
| `1` | The action failed. Herdr refused the request, sent no usable reply within 3 seconds, or still reports this plugin's view after All. The action also fails when it runs outside Herdr or as another plugin. The message names the cause. |
| `2` | The action name was not `focus`, `all`, or `restore`. |
| `3` | All left another tool's view in place. |

A Herdr server restart drops the view and every marker. The startup hook and the next detected agent apply Focus again, unless you chose All. With Herdr's socket but no state directory, the actions still work but save nothing, and `restore` acts as Focus. If you run All while a hook is applying Focus, the hook rereads your choice and clears its own Focus again. If a save fails, the log says so and the action still runs.

## Troubleshooting

- **A child you expect to be hidden is still visible.** Check that the parent loads a compatible extension, that you ran `/reload` in the parent after installing or upgrading it, and that the child was launched after the reload. Then run Focus again. A blocked child or a child with unknown status is always shown.
- **No child is ever marked.** Run `herdr pane get` on a child's pane. If it shows no `agent_session`, Herdr's Pi integration is missing from the agent directory the child uses. Install it with `herdr integration install pi`, then launch new children. A child that reports only a session ID, not a session file, is never marked.
- **Focus came back after I set another tool's view.** The hook replaces another tool's view whenever Herdr detects an agent. Run All to stop that.
- **A row you expect is missing.** Run All. Markers change only what the Agents view shows.
- **Focus or All exits with status `1`.** Read the log with the command above. The message names the cause, such as a Herdr build without the agent view API.
- **All exits with status `3`.** Another tool owns the view. All leaves it in place.
- **A new agent in a delegated pane is hidden.** See [Reusing a delegated pane](#reusing-a-delegated-pane).

## Safety

- Markers are display only. They are not a security boundary.
- The plugin sends requests to your local Herdr server. It does not close, move, or signal panes.
- Inside Herdr, the parent reads each child pane's agent session from Herdr and reports one pane token, `piha_delegated_v1`, through the Herdr socket. It writes no other pane metadata, and the token stays harmless when this plugin is not installed. See [Safety and uninstall](../../README.md#safety-and-uninstall) in the main README.

## Uninstall

1. Run All, or skip this step. Herdr also drops this plugin's view when you disable or uninstall the plugin. The hooks stop with the plugin.
2. Remove the plugin:

   ```bash
   herdr plugin uninstall pi-herdr-agents.sidebar
   ```

The extension keeps marking children after you uninstall the plugin. Without the plugin nothing reads the markers, so they change nothing you see. Uninstall the extension to stop them.

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

A `live` marker means Herdr reported the delegated child's own session file
for that pane within the last 15 seconds. It does not prove that the same
session occupies the pane when Herdr draws the row.

Herdr's Pi integration reports each Pi's session file for its pane. Herdr
drops that session when Pi releases the pane or exits, and replaces it when
another agent reports its own session. With Herdr 0.9.4 or later, a Pi
suspended with Ctrl-Z keeps its session, also after it resumes with `fg`,
until it exits. Herdr 0.9.3 and earlier drop it at suspend.

The parent Pi session writes the marker once Herdr reports the session file
the parent assigned to the child, waiting up to 15 seconds after launch. It
renews the marker every 4 to 5 seconds, and only after Herdr still reports
that session. Renewal runs on the parent's existing supervision checks, so if
those checks stall, the marker expires and the child reappears. The parent
clears the marker when the child finishes, when it stops supervising the
child, when Herdr no longer reports the child's session, or after three
failed renewal reads or writes in a row. The marker belongs to the pane, so it can
outlast the child briefly. See
[Reusing a delegated pane](#reusing-a-delegated-pane).

Each write carries a 15-second time-to-live and a sequence number that
increases across all of a parent's writes. The 15-second guarantee counts from
the last write Herdr accepted. It does not restart when the pane's occupant
changes. Herdr ignores a write whose
sequence number is not higher than the last one it applied, so a delayed
renewal cannot undo a clear. The extension does not retry a failed write and
stops writing after three failed renewal reads or writes in a row.

Some leftover markers still occur:

- If the parent process exits or crashes, its last marker stays until its
  time-to-live ends, up to 15 seconds after the last write Herdr applied.
- A renewal that Herdr processes late starts a new 15-second period, unless a
  clear with a higher sequence number has already arrived.
- After the child exits, the marker stays until the parent's next renewal
  clears it, usually within 5 seconds. A new agent started in the same pane
  during that window stays hidden by Focus until the clear arrives or the
  marker expires.
- With Herdr 0.9.4 or later, a suspended child stays marked, also after it
  resumes with `fg`, until it exits. A non-Pi program started at that pane's
  shell meanwhile can stay hidden by Focus until the suspended child exits.
  Herdr 0.9.3 and earlier clear the marker within about 5 seconds of
  suspending.
- If the parent restarts while the same Herdr server keeps running, and the
  system clock has moved backwards, the new parent's sequence numbers can fall
  behind the last ones Herdr applied. Herdr then ignores its writes until the
  clock catches up. A Herdr server restart resets the sequence state and drops
  every marker.

Run All whenever a row you expect is missing. Markers change only what the
Agents view shows. They are not a security boundary.

### Reusing a delegated pane

The marker follows the pane, but renewal follows the child's Pi session.
When the child exits, Herdr drops the child's session, and the parent clears
the marker at its next renewal. An agent you then start in that pane is shown
once the clear arrives, usually within 5 seconds, and at most 15 seconds
after the last write Herdr accepted if the clear is lost. A cleared marker
never returns.

With Herdr 0.9.4 or later, a child you suspend with Ctrl-Z keeps its session,
so its marker stays live, also after it resumes with `fg`, until it exits. A
non-Pi program you start at that pane's shell in the meantime can stay hidden
by Focus until the suspended child exits; run All to see it. Herdr 0.9.3 and
earlier drop the session at suspend, so the marker clears within about 5
seconds.

## Limits

- Tested on Linux with the Herdr builds named above and on macOS with Herdr
  `0.9.1`, each with one local server and one attached client. Remote
  machines and several attached clients are untested.
- Markers need Herdr's Pi integration. A Pi that reports only a session ID,
  or no session, is never marked.
- The marker follows the pane and can briefly outlast the child. See
  [Reusing a delegated pane](#reusing-a-delegated-pane).
- Herdr allows at most 32 sequenced metadata sources per pane. The extension
  uses the single source `pi-herdr-agents` for every marker.
- The plugin has no popup or settings. Its only state is the saved Focus or All
  choice. It does not hide workspaces or notifications.
