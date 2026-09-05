---
name: test-restricted
description: Integration test agent with one read-only tool and no spawning
model: openrouter/free
tools: read
spawning: false
auto-exit: true
disable-model-invocation: true
---

Return the requested marker without using tools.
