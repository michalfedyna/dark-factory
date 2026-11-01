import type { z } from 'zod';
import type { FactoryConfig } from '../config/schema.js';
import type { FigmaSource } from '../contracts/figma.js';
import {
  createFigmaClient,
  type figmaRequestSchema,
} from '../integrations/figma/client.js';
import { findFigmaSources } from '../integrations/figma/sources.js';

export interface FigmaAccessOptions {
  sources: FigmaSource[];
  token: string;
  tokenEnv?: string;
  auth: FactoryConfig['figma']['auth'];
  signal: AbortSignal;
}

/** Owns one agent session's source allowlist, credential use and read tracking. */
export function createFigmaAccess(options: FigmaAccessOptions) {
  const request = createFigmaClient(options.token, options.auth);
  const sources = new Map(
    options.sources.map((source) => [source.url, source]),
  );
  const inspected = new Set<string>();
  const resolveSource = (sourceUrl: string): FigmaSource => {
    const requested = findFigmaSources(sourceUrl)[0];
    const source = requested ? sources.get(requested.url) : undefined;
    if (!source) throw new Error('Use a supplied Figma source URL.');
    return source;
  };
  return {
    resolveSource,
    read: async (
      sourceUrl: string,
      input: z.infer<typeof figmaRequestSchema>,
      toolSignal?: AbortSignal,
    ) => {
      const signal = AbortSignal.any([
        options.signal,
        ...(toolSignal ? [toolSignal] : []),
      ]);
      signal.throwIfAborted();
      const source = resolveSource(sourceUrl);
      if (!options.token.trim())
        throw new Error(
          `Set ${options.tokenEnv ?? 'FIGMA_ACCESS_TOKEN'} in your environment or .env to inspect Figma designs.`,
        );
      const data = await request(source, input, signal);
      signal.throwIfAborted();
      if (
        (!source.nodeId && input.operation === 'file') ||
        (source.nodeId &&
          input.operation === 'nodes' &&
          input.nodeIds.includes(source.nodeId))
      )
        inspected.add(source.url);
      return data;
    },
    addSources: (additional: FigmaSource[]) => {
      for (const source of additional) sources.set(source.url, source);
    },
    unreadSources: () =>
      [...sources.values()].filter(({ url }) => !inspected.has(url)),
  };
}
