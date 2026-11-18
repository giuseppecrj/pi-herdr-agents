import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWidgetController } from '../../../../pi-extension/subagents/widgets.ts';
import { createLifecycle, markCompletionDetected, projectLifecycle } from '@nubl/maestro/core/lifecycle';

function fixture(duration) {
  const startTime = 5_000;
  const endTime = startTime + duration;
  const lifecycle = markCompletionDetected(createLifecycle(startTime), { reason: 'done', exitCode: 0 }, endTime);
  const agent = { id: 'frozen', name: 'FrozenProbe', task: '', surface: 's1', startTime, sessionFile: 'sess1', lifecycle, interactive: false, runtimePlan: undefined };
  let factory;
  const controller = createWidgetController({ runtime: { runningSubagents: new Map([[agent.id, agent]]), latestCtx: { hasUI: true, ui: { setWidget(_key, value) { factory = value; } } } }, statusConfig: { enabled: true }, supervisionConfig: {}, observeRunningSubagent() {}, evaluateNoProgressAdvisory() {} });
  return { lifecycle, endTime, render() {
    if (typeof controller.renderSubagentWidgetLines === 'function') return controller.renderSubagentWidgetLines([agent], 100);
    assert.equal(typeof controller.updateWidget, 'function');
    controller.updateWidget();
    assert.equal(typeof factory, 'function');
    return factory({}, {}).render(100);
  } };
}

for (const [duration, expected] of [[0, '00:00'], [999, '00:00'], [1000, '00:01'], [187_000, '03:07'], [187_999, '03:07'], [3_599_999, '59:59']]) {
  test(`sub-hour flooring remains ${expected} at ${duration}ms`, () => {
    const f = fixture(duration);
    assert.match(f.render()[1], new RegExp(`\\s${expected}\\s+FrozenProbe`));
  });
}

test('completion uses lifecycle runtime end rather than the current wall clock', () => {
  const f = fixture(15_000);
  assert.equal(projectLifecycle(f.lifecycle, 30_000).runtimeEndedAt, f.endTime);
  assert.equal(projectLifecycle(f.lifecycle, 99_999_999).runtimeEndedAt, f.endTime);
  for (let i = 0; i < 3; i++) {
    const lines = f.render();
    assert.match(lines[0], /1 open/);
    assert.match(lines[1], /\s00:15\s+FrozenProbe/);
    assert.match(lines[1], /finalizing…/);
    assert.doesNotMatch(lines[1], /00:25/);
  }
});
// factory-holdout-7de623c4ae354330e2b2a5737b448a547e5ecf938bd538140091dad67b0b9c64
