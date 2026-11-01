import { createTool } from '@mastra/core/tools';
import {
  executeQaCommand,
  prepareQaArguments,
  qaCommandSchema,
  type QaToolOptions,
} from './qa-command.js';

export function createAgentBrowserTool(options: QaToolOptions) {
  return createTool({
    id: 'agent-browser',
    description:
      'Use agent-browser to verify a configured web target. open takes no args and opens the approved URL. screenshot takes no args and saves a validated PNG to a controller-owned path; inspect that path with workspace read_file. help takes one operation name. Other args are literal CLI arguments, not shell syntax. Global configuration/session/platform/file overrides are forbidden. Returns a trusted evidence ID and path.',
    inputSchema: qaCommandSchema,
    execute: async ({ targetId, operation, args }) => {
      options.signal.throwIfAborted();
      const target = options.config.targets.find(
        (entry) => entry.id === targetId,
      );
      if (!target || target.kind !== 'web')
        throw new Error('Unknown web QA target.');
      const prepared = await prepareQaArguments(
        operation,
        args,
        target.url,
        options.evidence,
      );
      return executeQaCommand(options, {
        kind: 'browser',
        targetId,
        operation,
        command: options.config.browserCommand,
        args: [
          '--config',
          options.browserConfig,
          '--session',
          `${options.session}-${targetId}`,
          '--allowed-domains',
          new URL(target.url).hostname,
          ...(operation === 'help'
            ? [prepared[0]!, '--help']
            : [operation, ...prepared]),
        ],
        screenshot: operation === 'screenshot' ? prepared[0] : undefined,
      });
    },
  });
}
