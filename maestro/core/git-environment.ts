const REPOSITORY_OVERRIDES = new Set([
	"GIT_DIR",
	"GIT_COMMON_DIR",
	"GIT_WORK_TREE",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_PREFIX",
	"GIT_SHALLOW_FILE",
	"GIT_GRAFT_FILE",
	"GIT_REPLACE_REF_BASE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
]);

/** Keep user configuration while letting host Git commands select their own checkout. */
export function gitEnvironment(
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env = { ...source };
	for (const key of Object.keys(env)) {
		if (
			REPOSITORY_OVERRIDES.has(key) ||
			/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
		) {
			delete env[key];
		}
	}
	return env;
}
