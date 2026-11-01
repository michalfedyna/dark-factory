import type { FigmaSource } from '../contracts/figma.js';

/** Keep design references even when exploration leaves them out of its brief. */
export function findFigmaSources(...inputs: string[]): FigmaSource[] {
  const sources = new Map<string, FigmaSource>();
  for (const input of inputs) {
    for (const match of input.matchAll(
      /https:\/\/(?:www\.)?figma\.com\/[^\s<>"'`\\)\]}]+/gi,
    )) {
      const url = new URL(match[0].replace(/[.,;!?]+$/, ''));
      const parts = url.pathname.split('/');
      if (!['design', 'file', 'proto'].includes(parts[1] ?? '')) continue;
      const fileKey = parts[3] === 'branch' ? parts[4] : parts[2];
      if (!fileKey || !/^[A-Za-z0-9]+$/.test(fileKey)) continue;
      const rawNode = url.searchParams.get('node-id');
      const nodeId = rawNode?.replace(/(\d)-(\d)/g, '$1:$2') ?? null;
      if (nodeId && !/^[A-Za-z0-9_:;-]+$/.test(nodeId)) continue;
      const version = url.searchParams.get('version-id');
      const canonical = new URL(`https://www.figma.com/design/${fileKey}`);
      if (nodeId) canonical.searchParams.set('node-id', nodeId);
      if (version) canonical.searchParams.set('version-id', version);
      sources.set(canonical.href, {
        url: canonical.href,
        fileKey,
        nodeId,
        version,
      });
    }
  }
  return [...sources.values()];
}
