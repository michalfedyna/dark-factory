import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { figmaRequestSchema } from '../integrations/figma/client.js';
import { createFigmaAccess, type FigmaAccessOptions } from './figma-access.js';

export function createFigmaTools(options: FigmaAccessOptions) {
  const access = createFigmaAccess(options);
  const figma = createTool({
    id: 'figma',
    description:
      'Read linked Figma designs through REST: file tree, node layout/style/component data, PNG/SVG renders, image fills, library components/styles, and local variables (Enterprise access required). No Figma writes.',
    inputSchema: figmaRequestSchema.extend({
      source: z
        .url()
        .describe(
          'A Figma URL supplied in the issue, user answers, or sources list. Tracking parameters and node ID formats are normalized.',
        ),
    }),
    outputSchema: z.strictObject({
      data: z.record(z.string(), z.unknown()),
      previews: z.array(z.url()),
    }),
    execute: async ({ source: sourceUrl, ...request }, context) => {
      const data = await access.read(sourceUrl, request, context?.abortSignal);
      const images = z
        .record(z.string(), z.url().nullable())
        .safeParse(data.images);
      return {
        data,
        previews:
          request.operation === 'render' &&
          request.format === 'png' &&
          images.success
            ? Object.values(images.data)
                .filter((url): url is string => url !== null)
                .slice(0, 4)
            : [],
      };
    },
    toModelOutput: ({ data, previews }) => ({
      type: 'content',
      value: [
        { type: 'text', text: JSON.stringify(data) },
        ...previews.map((url) => ({ type: 'image-url' as const, url })),
      ],
    }),
  });
  return {
    figma,
    unreadSources: access.unreadSources,
  };
}
