import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { figmaRequestSchema } from '../integrations/figma/client.js';
import { downloadFigmaPng } from '../integrations/figma/images.js';
import { createFigmaAccess, type FigmaAccessOptions } from './figma-access.js';

const frameSchema = z.object({ id: z.string(), name: z.string() });
const pageSchema = z.object({ children: z.array(frameSchema).default([]) });

/** Exploration gets PNGs and screen names, not implementation specifications. */
export function createFigmaPreviewTools(options: FigmaAccessOptions) {
  const access = createFigmaAccess(options);
  const figma = createTool({
    id: 'figma',
    description:
      'View user-linked Figma designs as PNGs. Use preview for a node link (its node ID is automatic), or frames to list only top-level screen IDs/names for a whole-file link, then preview selected nodeIds. No layout, style, token or component specifications.',
    inputSchema: z.strictObject({
      source: z
        .url()
        .describe('A Figma URL supplied in the issue or a real user answer.'),
      operation: z.enum(['preview', 'frames']),
      nodeIds: figmaRequestSchema.shape.nodeIds.unwrap().max(4).default([]),
    }),
    outputSchema: z.strictObject({
      frames: z.array(frameSchema),
      previews: z.array(
        z.strictObject({ nodeId: z.string(), image: z.string().min(1) }),
      ),
    }),
    execute: async ({ source, operation, nodeIds }, context) => {
      const signal = AbortSignal.any([
        options.signal,
        ...(context?.abortSignal ? [context.abortSignal] : []),
      ]);
      signal.throwIfAborted();
      if (operation === 'frames') {
        const data = await access.read(
          source,
          figmaRequestSchema.parse({ operation: 'file', depth: 2 }),
          signal,
        );
        const document = z
          .object({ children: z.array(pageSchema).default([]) })
          .parse(data.document);
        return {
          frames: document.children.flatMap((page) => page.children),
          previews: [],
        };
      }
      const linked = access.resolveSource(source);
      const ids = nodeIds.length
        ? nodeIds
        : linked.nodeId
          ? [linked.nodeId]
          : [];
      if (!ids.length)
        throw new Error(
          'Use frames to choose screen nodeIds, or provide a Figma node link.',
        );
      const data = await access.read(
        source,
        figmaRequestSchema.parse({
          operation: 'render',
          nodeIds: ids,
          format: 'png',
        }),
        signal,
      );
      const images = z
        .record(z.string(), z.url().nullable())
        .parse(data.images);
      const previews = [];
      for (const nodeId of ids) {
        const url = images[nodeId];
        if (!url)
          throw new Error('Figma did not return the requested PNG preview.');
        previews.push({ nodeId, image: await downloadFigmaPng(url, signal) });
      }
      return {
        frames: [],
        previews,
      };
    },
    toModelOutput: ({ frames, previews }) => ({
      type: 'content',
      value: [
        {
          type: 'text',
          text: JSON.stringify({
            frames,
            previewNodeIds: previews.map(({ nodeId }) => nodeId),
          }),
        },
        ...previews.map(({ image }) => ({
          type: 'media' as const,
          data: image,
          mediaType: 'image/png',
        })),
      ],
    }),
  });
  return { figma, addSources: access.addSources };
}
