import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { FactoryConfig } from '../config/schema.js';
import type { FigmaSource } from '../contracts/figma.js';
import {
  createFigmaClient,
  figmaRequestSchema,
} from '../integrations/figma/client.js';

export function createFigmaTools(options: {
  sources: FigmaSource[];
  token: string;
  auth: FactoryConfig['figma']['auth'];
  signal: AbortSignal;
}) {
  const read = createFigmaClient(options.token, options.auth);
  const inspected = new Set<string>();
  const figma = createTool({
    id: 'figma',
    description:
      'Read linked Figma designs through REST: file tree, node layout/style/component data, PNG/SVG renders, image fills, library components/styles, and local variables (Enterprise access required). No Figma writes.',
    inputSchema: figmaRequestSchema.extend({
      source: z
        .string()
        .describe('Exact source URL from the supplied sources list.'),
    }),
    outputSchema: z.strictObject({
      data: z.record(z.string(), z.unknown()),
      previews: z.array(z.url()),
    }),
    execute: async ({ source: sourceUrl, ...request }, context) => {
      const source = options.sources.find(({ url }) => url === sourceUrl);
      if (!source) throw new Error('Use a supplied Figma source URL.');
      const signal = AbortSignal.any([
        options.signal,
        ...(context?.abortSignal ? [context.abortSignal] : []),
      ]);
      const data = await read(source, request, signal);
      signal.throwIfAborted();
      if (
        (!source.nodeId && request.operation === 'file') ||
        (source.nodeId &&
          request.operation === 'nodes' &&
          request.nodeIds.includes(source.nodeId))
      )
        inspected.add(source.url);
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
    unreadSources: () =>
      options.sources.filter(({ url }) => !inspected.has(url)),
  };
}
