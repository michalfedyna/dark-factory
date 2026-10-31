import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { questionSchema, type Ask } from '../contracts/interaction.js';

export function createAskTool(ask: Ask, signal: AbortSignal) {
  return createTool({
    id: 'ask',
    description:
      "Ask the user one focused question and wait for their actual answer. Also use this to show the final proposed brief and ask for confirmation. Never answer on the user's behalf.",
    inputSchema: questionSchema,
    outputSchema: z.strictObject({ answer: z.string() }),
    execute: async (question) => ({ answer: await ask(question, signal) }),
  });
}
