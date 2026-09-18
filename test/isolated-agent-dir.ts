import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import before the extension: configuration is loaded during module evaluation.
const directory = mkdtempSync(join(tmpdir(), "initfix-test-agent-"));
process.env.PI_CODING_AGENT_DIR = directory;
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
