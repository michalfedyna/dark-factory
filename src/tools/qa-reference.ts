import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { QaReference } from '../delivery/qa-references.js';

export function createQaReferenceTool(
  references: QaReference[],
  signal: AbortSignal,
) {
  return createTool({
    id: 'qa_reference',
    description:
      'View a supplied design reference PNG by its ID. This is reference material, not evidence that the candidate passed. No file paths or URLs are accepted.',
    inputSchema: z.strictObject({ referenceId: z.string() }),
    outputSchema: z.strictObject({ name: z.string(), image: z.string() }),
    execute: ({ referenceId }, context) => {
      signal.throwIfAborted();
      context?.abortSignal?.throwIfAborted();
      const reference = references.find(({ id }) => id === referenceId);
      if (!reference) throw new Error('Unknown QA design reference.');
      return Promise.resolve({ name: reference.name, image: reference.image });
    },
    toModelOutput: ({ name, image }) => ({
      type: 'content',
      value: [
        {
          type: 'text',
          text: `Design reference: ${name}. Not candidate evidence.`,
        },
        { type: 'media', data: image, mediaType: 'image/png' },
      ],
    }),
  });
}
