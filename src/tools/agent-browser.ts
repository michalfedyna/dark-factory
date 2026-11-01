import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  executeQaCommand,
  prepareQaArguments,
  qaCommandSchema,
  qaModelOutput,
  qaResultSchema,
  type QaToolOptions,
} from './qa-command.js';

const browserCommandSchema = qaCommandSchema.extend({
  operation: z.enum([...qaCommandSchema.shape.operation.options, 'viewport']),
});

export function createAgentBrowserTool(options: QaToolOptions) {
  return createTool({
    id: 'agent-browser',
    description:
      'Use agent-browser to test application behavior on a configured web target. open takes no args and opens the approved URL. viewport takes [width, height] as integer strings from 1 to 10000 CSS pixels to check mobile and desktop layouts of the same web target. screenshot takes no args and returns the captured UI image directly. help takes one operation name, including viewport. Other args are literal CLI arguments, not shell syntax. Global configuration/session/platform/file overrides are forbidden. Returns observed results and a trusted evidence ID.',
    inputSchema: browserCommandSchema,
    outputSchema: qaResultSchema,
    toModelOutput: qaModelOutput,
    execute: async ({ targetId, operation, args }) => {
      options.signal.throwIfAborted();
      const target = options.project.targets.find(
        (entry) => entry.id === targetId,
      );
      if (!target || target.kind !== 'web')
        throw new Error('Unknown web QA target.');
      let prepared: string[];
      if (operation === 'viewport') {
        if (
          args.length !== 2 ||
          args.some((arg) => !/^[1-9]\d*$/.test(arg) || Number(arg) > 10_000)
        )
          throw new Error(
            'viewport requires width and height as integers from 1 to 10000 CSS pixels.',
          );
        prepared = ['set', 'viewport', ...args];
      } else if (operation === 'help' && args[0] === 'viewport') {
        if (args.length !== 1)
          throw new Error('Request help for one supported operation.');
        prepared = ['set', '--help'];
      } else {
        const values = await prepareQaArguments(
          operation,
          args,
          target.url,
          options.evidence,
        );
        prepared =
          operation === 'help'
            ? [values[0]!, '--help']
            : [operation, ...values];
      }
      return executeQaCommand(options, {
        kind: 'browser',
        targetId,
        operation,
        command: options.project.browserCommand,
        args: [
          '--config',
          options.browserConfig,
          '--session',
          `${options.session}-${targetId}`,
          '--allowed-domains',
          new URL(target.url).hostname,
          ...prepared,
        ],
        screenshot: operation === 'screenshot' ? prepared[1] : undefined,
      });
    },
  });
}
