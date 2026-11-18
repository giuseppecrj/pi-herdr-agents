import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { visibleWidth } from '@earendil-works/pi-tui';
import { borderLine, createWidgetController } from '../../../../pi-extension/subagents/widgets.ts';
import { createLifecycle, markInterruptRequested } from '@nubl/maestro/core/lifecycle';

test('the existing widget test inventory remains byte-for-byte unchanged', () => {
  const bytes = readFileSync(resolve(process.cwd(), 'test/test.ts'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '9b45de697e5fe59c9cf297b67fddf59f1752e72e2e14e3ca2baeb6699ea7bb45');
});

test('border truncation still preserves the width contract', () => {
  for (const width of [0, 1, 2, 16, 64]) {
    assert.equal(visibleWidth(borderLine(' 12:00:00 Worker ', ' 999 msgs (999.9KB) ', width)), width);
  }
});

test('interrupted agents remain open with the existing accent and narrow rendering', () => {
  const now = Date.now();
  const startTime = now - 25_000;
  const lifecycle = markInterruptRequested({ ...createLifecycle(startTime), process: { kind: 'running', startedAt: startTime, confirmedAt: startTime } }, now - 10_000);
  const agent = { id: 'open', name: 'Worker', task: '', surface: 's1', startTime, sessionFile: 'sess1', lifecycle, interactive: false, runtimePlan: undefined };
  let factory;
  const controller = createWidgetController({ runtime: { runningSubagents: new Map([[agent.id, agent]]), latestCtx: { hasUI: true, ui: { setWidget(_key, value) { factory = value; } } } }, statusConfig: { enabled: true }, supervisionConfig: {}, observeRunningSubagent() {}, evaluateNoProgressAdvisory() {} });
  function render(width) {
    if (typeof controller.renderSubagentWidgetLines === 'function') return controller.renderSubagentWidgetLines([agent], width);
    assert.equal(typeof controller.updateWidget, 'function');
    controller.updateWidget();
    assert.equal(typeof factory, 'function');
    return factory({}, {}).render(width);
  }
  const lines = render(100);
  assert.match(lines[0], /1 open/);
  assert.ok(lines[0].includes('\x1b[38;2;214;158;46m'));
  assert.match(lines[1], /interrupted/);
  assert.doesNotMatch(lines.join('\n'), /running|active/);
  for (const width of [0, 1, 2, 16]) {
    const narrow = render(width);
    assert.equal(narrow.length, 3);
    for (const line of narrow) assert.equal(visibleWidth(line), width);
  }
});
// factory-holdout-7de623c4ae354330e2b2a5737b448a547e5ecf938bd538140091dad67b0b9c64
