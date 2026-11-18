import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWidgetController } from '../../../../pi-extension/subagents/widgets.ts';
import { createLifecycle, markCompletionDetected } from '@nubl/maestro/core/lifecycle';

function render(duration, width = 100) {
  const startTime = 100_000_000;
  const lifecycle = markCompletionDetected(createLifecycle(startTime), { reason: 'done', exitCode: 0 }, startTime + duration);
  const agent = { id: 'elapsed', name: 'ElapsedProbe', task: '', surface: 's1', startTime, sessionFile: 'sess1', lifecycle, interactive: false, runtimePlan: undefined };
  let factory;
  const runtime = { runningSubagents: new Map([[agent.id, agent]]), latestCtx: { hasUI: true, ui: { setWidget(_key, value) { factory = value; } } } };
  const controller = createWidgetController({ runtime, statusConfig: { enabled: true }, supervisionConfig: {}, observeRunningSubagent() {}, evaluateNoProgressAdvisory() {} });
  if (typeof controller.renderSubagentWidgetLines === 'function') return controller.renderSubagentWidgetLines([agent], width);
  assert.equal(typeof controller.updateWidget, 'function', 'controller retains its widget rendering seam');
  controller.updateWidget();
  assert.equal(typeof factory, 'function');
  return factory({}, {}).render(width);
}

for (const [duration, expected] of [[3_600_000, '1:00:00'], [3_725_000, '1:02:05'], [43_200_000, '12:00:00'], [3_725_999, '1:02:05'], [359_999_999, '99:59:59'], [360_000_000, '100:00:00']]) {
  test(`completed widget formats ${duration}ms as ${expected}`, () => {
    const lines = render(duration);
    assert.match(lines[1], new RegExp(`\\s${expected}\\s+ElapsedProbe`));
    assert.match(lines[1], /finalizing…/);
  });
}

for (const duration of [-1, -999, -1000, -187_000, -3_725_000]) {
  test(`selected runtime end preceding start by ${-duration}ms clamps to zero`, () => {
    const lines = render(duration);
    assert.match(lines[1], /\s00:00\s+ElapsedProbe/);
    assert.doesNotMatch(lines[1], /-\d/);
  });
}
// factory-holdout-7de623c4ae354330e2b2a5737b448a547e5ecf938bd538140091dad67b0b9c64
