import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LocalFilesystem,
  LocalSandbox,
  Workspace,
} from '@mastra/core/workspace';
import { expect, test, vi } from 'vitest';
import { createFigma } from '../src/agents/figma.js';
import { createIssueTask } from '../src/agents/task.js';
import { createFigmaTools } from '../src/tools/figma.js';
import { createFigmaProvider } from './fixtures/figma-provider.js';
import { brief } from './fixtures/brief.js';
import { figmaSource } from './fixtures/figma.js';
import { unusedTestTool } from './fixtures/progress-test.js';

test.each([
  ['chat', false],
  ['responses', false],
  ['chat', true],
  ['responses', true],
] as const)(
  'Figma uses REST and real Mastra repository tools (%s, streaming: %s)',
  async (api, streaming) => {
    const provider = await createFigmaProvider(api, 'delivery-figma-images');
    const { directory, config, controller, restFetch } = provider;
    const repository = join(directory, 'repository');
    await mkdir(repository);
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: repository }),
      sandbox: new LocalSandbox({ workingDirectory: repository, timeout: 0 }),
    });
    try {
      const tools = createFigmaTools({
        sources: [figmaSource],
        token: 'private-figma-token',
        auth: 'personal',
        signal: controller.signal,
      });
      const result = await createFigma(
        config.model,
        'test-key',
      )({
        context: {
          task: createIssueTask(brief),
          allowedPaths: ['.'],
          sources: [figmaSource],
        },
        workspace,
        tools: { figma: tools.figma, test: unusedTestTool(controller.signal) },
        signal: controller.signal,
        ...(streaming ? { debug: vi.fn() } : {}),
      });
      expect(result.blockers).toEqual([]);
      expect(result.components).toEqual(['ui-scaffold.tsx: Panel']);
      expect(await readFile(join(repository, 'ui-scaffold.tsx'), 'utf8')).toBe(
        'export const Panel = () => null;',
      );
      expect(restFetch).toHaveBeenCalledTimes(2);
      const wire = JSON.stringify(provider.modelRequests);
      expect(wire).toMatch(/"type":"(?:image_url|input_image)"/);
      expect(wire).toContain('export.png');
      expect(restFetch.mock.calls[0]?.[1]?.headers).toEqual({
        'X-Figma-Token': 'private-figma-token',
      });
      expect(tools.unreadSources()).toEqual([]);
      const contexts = await readFile(
        join(directory, 'agent-contexts.jsonl'),
        'utf8',
      );
      expect(contexts).toContain('"role":"figma"');
      expect(contexts).not.toContain('private-figma-token');
      expect(JSON.stringify(result)).not.toContain('private-figma-token');
    } finally {
      controller.abort();
      await workspace.destroy();
      await provider.close();
    }
  },
);
