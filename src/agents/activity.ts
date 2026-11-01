import type { ToolHooks } from '@mastra/core/tools';
import type { Observe } from '../contracts/progress.js';

export function createActivityHooks(
  agent: string,
  observe?: Observe,
): ToolHooks {
  // Forward metadata only, never tool arguments, output, or provider errors.
  return {
    beforeToolCall: ({ toolName }) => {
      observe?.({ kind: 'tool', agent, tool: toolName, status: 'started' });
    },
    afterToolCall: ({ toolName, error }) => {
      observe?.({
        kind: 'tool',
        agent,
        tool: toolName,
        status: error === undefined ? 'completed' : 'failed',
      });
    },
  };
}
