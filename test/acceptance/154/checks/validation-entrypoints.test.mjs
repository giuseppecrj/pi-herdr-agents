import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('required validation entrypoints retain the trusted commands', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
  const expected = {
    test: 'node --experimental-strip-types --test test/test.ts test/verify-lab-guards.test.ts test/worktree-cleanup.test.ts test/launch.test.ts test/release-workflow.test.ts test/system-prompt-mode.test.ts test/package-manifest.test.js test/sidebar-plugin.test.js test/maestro/*.test.ts',
    lint: 'oxlint pi-extension test maestro plugins scripts',
    'format:check': 'biome format pi-extension test maestro plugins scripts',
    typecheck: 'tsc -p .',
    'docs:tools:check': 'node --experimental-strip-types scripts/update-tool-docs.ts --check'
  };
  for (const [name, command] of Object.entries(expected)) assert.equal(pkg.scripts[name], command);
  assert.equal(pkg.scripts.prepack, undefined, 'package preview has no added prepack lifecycle command');
  assert.equal(pkg.scripts.postpack, undefined, 'package preview has no added postpack lifecycle command');
});
// factory-holdout-7de623c4ae354330e2b2a5737b448a547e5ecf938bd538140091dad67b0b9c64
