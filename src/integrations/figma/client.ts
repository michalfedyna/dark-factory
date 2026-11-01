import { z } from 'zod';
import type { FactoryConfig } from '../../config/schema.js';
import type { FigmaSource } from '../../contracts/figma.js';

const documentSchema = z.object({ id: z.string().min(1) });
const nodeId = z
  .string()
  .regex(/^[A-Za-z0-9_:;-]+$/)
  .max(200);
export const figmaRequestSchema = z.strictObject({
  operation: z.enum([
    'file',
    'nodes',
    'render',
    'image-fills',
    'components',
    'component-sets',
    'styles',
    'variables',
  ]),
  nodeIds: z.array(nodeId).max(100).default([]),
  depth: z.number().int().positive().max(20).optional(),
  format: z.enum(['png', 'svg']).default('png'),
});

/** Only fixed, read-only Figma endpoints receive the factory-owned credential. */
export function createFigmaClient(
  token: string,
  auth: FactoryConfig['figma']['auth'],
) {
  return async (
    source: FigmaSource,
    request: z.infer<typeof figmaRequestSchema>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    signal.throwIfAborted();
    const key = encodeURIComponent(source.fileKey);
    const suffixes = {
      file: '',
      nodes: '/nodes',
      'image-fills': '/images',
      components: '/components',
      'component-sets': '/component_sets',
      styles: '/styles',
      variables: '/variables/local',
      render: '',
    };
    const url = new URL(
      request.operation === 'render'
        ? `https://api.figma.com/v1/images/${key}`
        : `https://api.figma.com/v1/files/${key}${suffixes[request.operation]}`,
    );
    if (
      ['nodes', 'render'].includes(request.operation) &&
      !request.nodeIds.length
    )
      throw new Error('Figma nodes and render requests require nodeIds.');
    if (['file', 'nodes', 'render'].includes(request.operation)) {
      if (source.version) url.searchParams.set('version', source.version);
      if (request.nodeIds.length)
        url.searchParams.set('ids', request.nodeIds.join(','));
    }
    if (['file', 'nodes'].includes(request.operation)) {
      const depth =
        request.depth ?? (request.operation === 'file' ? 2 : undefined);
      if (depth) url.searchParams.set('depth', String(depth));
    }
    if (request.operation === 'render')
      url.searchParams.set('format', request.format);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers:
          auth === 'oauth'
            ? { Authorization: `Bearer ${token}` }
            : { 'X-Figma-Token': token },
        signal,
      });
    } catch {
      signal.throwIfAborted();
      throw new Error('Figma REST request failed. Check network access.');
    }
    signal.throwIfAborted();
    if (!response.ok) {
      const advice =
        response.status === 429
          ? 'Rate limited; retry in a later run.'
          : response.status === 401 || response.status === 403
            ? 'Check token expiry, file access, scopes, and Figma plan access.'
            : response.status === 404
              ? 'The linked file or branch is unavailable.'
              : 'The design could not be read.';
      throw new Error(`Figma REST ${response.status}. ${advice}`);
    }
    let data: Record<string, unknown>;
    try {
      data = z.record(z.string(), z.unknown()).parse(await response.json());
    } catch {
      signal.throwIfAborted();
      throw new Error('Figma REST returned an invalid JSON object.');
    }
    signal.throwIfAborted();
    if (data.err || data.error)
      throw new Error('Figma REST could not return the requested design data.');
    if (
      request.operation === 'file' &&
      !documentSchema.safeParse(data.document).success
    )
      throw new Error('Figma REST did not return a file document.');
    if (request.operation === 'nodes' || request.operation === 'render') {
      const entries =
        request.operation === 'nodes'
          ? z
              .record(
                z.string(),
                z.object({ document: documentSchema }).nullable(),
              )
              .safeParse(data.nodes)
          : z
              .record(z.string(), z.url({ protocol: /^https$/ }).nullable())
              .safeParse(data.images);
      if (!entries.success || request.nodeIds.some((id) => !entries.data[id]))
        throw new Error(
          'Figma REST could not return every requested node. Check node IDs and visibility.',
        );
    }
    return data;
  };
}
