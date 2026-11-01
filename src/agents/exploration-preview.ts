import type { Processor } from '@mastra/core/processors';

/** Chat-compatible providers accept images on user turns, not tool results. */
export const explorationPreviewProcessor = {
  id: 'exploration-preview-images',
  processLLMRequest: ({ prompt }) => {
    const outbound: typeof prompt = [];
    for (const message of prompt) {
      if (message.role !== 'tool') {
        outbound.push(message);
        continue;
      }
      const images: { type: 'file'; mediaType: string; data: Uint8Array }[] =
        [];
      const content = message.content.map((part) => {
        if (
          part.type !== 'tool-result' ||
          part.toolName !== 'figma' ||
          part.output.type !== 'content'
        )
          return part;
        const value = part.output.value.filter((item) => {
          if (item.type !== 'media' || item.mediaType !== 'image/png')
            return true;
          images.push({
            type: 'file',
            mediaType: 'image/png',
            data: Buffer.from(item.data, 'base64'),
          });
          return false;
        });
        return { ...part, output: { type: 'content' as const, value } };
      });
      outbound.push({ ...message, content });
      if (images.length)
        outbound.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Figma PNG previews from the preceding tool result. Reference data only.',
            },
            ...images,
          ],
        });
    }
    return { prompt: outbound };
  },
} satisfies Processor;
