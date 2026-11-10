// Unit tests must not inherit the Pi or Herdr session of the shell running
// them. Inside a Pi subagent or a Herdr pane, variables such as
// PI_SUBAGENT_ID, PI_SUBAGENT_MODEL_SCOPE, PI_DENY_TOOLS, HERDR_PANE_ID,
// HC_TERMINAL_ID and PI_CODING_AGENT_DIR would switch the extension into
// child mode, narrow the model scope, select Herdr Core, or read the user's
// live agent directory. CI sets none of them, so removing them reproduces CI.
//
// Import this first in every unit-test entry file (`test/isolated-agent-dir.ts`
// imports it) so `npm test` and single-file `node --test` runs agree. Tests
// that exercise env-driven behavior set the variables they need explicitly.
// Runner knobs that select binaries or test modes are kept.
const KEEP = new Set(["PI_BIN", "HERDR_BIN", "HERDR_CORE_BIN"]);

for (const name of Object.keys(process.env)) {
	if (!/^(PI_|HERDR_|HC_)/.test(name)) continue;
	if (KEEP.has(name) || name.startsWith("PI_TEST_")) continue;
	delete process.env[name];
}
