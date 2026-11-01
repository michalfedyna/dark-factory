import { createTool } from '@mastra/core/tools';
import {
  executeQaCommand,
  prepareQaArguments,
  qaCommandSchema,
  type QaToolOptions,
} from './qa-command.js';

export function createAgentDeviceTool(options: QaToolOptions) {
  return createTool({
    id: 'agent-device',
    description:
      'Use agent-device to verify a configured native iOS/Android target, never browser emulation. open takes no args and opens the approved app on the configured device. screenshot takes no args and saves a validated PNG to a controller-owned path; inspect that path with workspace read_file. help takes one operation name. Other args are literal CLI arguments, not shell syntax. Global configuration/session/platform/file overrides are forbidden. Returns a trusted evidence ID and path.',
    inputSchema: qaCommandSchema,
    execute: async ({ targetId, operation, args }) => {
      options.signal.throwIfAborted();
      const target = options.config.targets.find(
        (entry) => entry.id === targetId,
      );
      if (!target || target.kind !== 'mobile')
        throw new Error('Unknown mobile QA target.');
      const prepared = await prepareQaArguments(
        operation,
        args,
        target.app,
        options.evidence,
      );
      return executeQaCommand(options, {
        kind: 'device',
        targetId,
        operation,
        command: options.config.deviceCommand,
        args: [
          operation,
          ...prepared,
          '--session',
          `${options.session}-${targetId}`,
          '--platform',
          target.platform,
          ...(target.device ? ['--device', target.device] : []),
        ],
        screenshot: operation === 'screenshot' ? prepared[0] : undefined,
      });
    },
  });
}
