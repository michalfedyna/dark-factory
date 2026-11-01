import type { LocalSandbox } from '@mastra/core/workspace';
import type { EvidenceRecorder } from './evidence.js';

/** Record native sandbox results without replacing Mastra command execution. */
export function recordSandboxQaCommands(
  sandbox: LocalSandbox,
  evidence: EvidenceRecorder,
) {
  const executeCommand = sandbox.executeCommand?.bind(sandbox);
  if (!executeCommand)
    throw new Error('Sandbox QA requires command execution.');
  sandbox.executeCommand = async (command, args, options) => {
    let result;
    try {
      result = await executeCommand(command, args, options);
    } catch (error) {
      await evidence.record(
        {
          kind: 'sandbox',
          targetId: null,
          operation: 'execute-command',
          exitCode: 1,
        },
        {
          command,
          args: args ?? [],
          error: error instanceof Error ? error.message : String(error),
        },
      );
      throw error;
    }
    await evidence.record(
      {
        kind: 'sandbox',
        targetId: null,
        operation: 'execute-command',
        exitCode: result.success ? result.exitCode : result.exitCode || 1,
      },
      { ...result, command, args: args ?? [] },
    );
    return result;
  };
}
