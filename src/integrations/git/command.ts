import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repositoryEnvironment = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
]);

/** Only trusted Git/GitHub operations run here. Project commands use Mastra. */
export async function hostCommand(
  command: 'git' | 'gh',
  args: string[],
  signal: AbortSignal,
  cwd?: string,
): Promise<string> {
  signal.throwIfAborted();
  // Git hooks export repository-local paths, including their index. Foreign
  // repository commands must not reuse that state or modify the caller's index.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !repositoryEnvironment.has(key) &&
        !/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key),
    ),
  );
  try {
    const result = await execute(command, args, {
      ...(cwd ? { cwd } : {}),
      signal,
      maxBuffer: Infinity,
      env: {
        ...env,
        GIT_TERMINAL_PROMPT: '0',
        GH_PROMPT_DISABLED: '1',
      },
    });
    signal.throwIfAborted();
    return result.stdout;
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(
      `${command} operation failed. Check repository access, authentication, and command installation.`,
      { cause: error },
    );
  }
}
