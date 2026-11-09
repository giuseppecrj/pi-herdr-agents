---
name: test-interactive
description: Integration fixture for interrupted turns in a retained Pi session
model: openrouter/free
tools: read, bash
spawning: false
auto-exit: false
interactive: true
disable-model-invocation: true
---

Execute the requested shell task. Stay available for follow-up input after the turn ends.
