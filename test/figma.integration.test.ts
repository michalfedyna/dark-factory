import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LocalFilesystem,
  LocalSandbox,
  Workspace,
} from '@mastra/core/workspace';
import { expect, test, vi } from 'vitest';
import { createFigma } from '../src/agents/figma.js';
import { createIssueTask } from '../src/agents/task.js';
import { factoryConfigSchema } from '../src/config/schema.js';
import { startRouter } from '../src/integrations/router/process.js';
import { createFigmaTools } from '../src/tools/figma.js';
import { availablePort } from './fixtures/integration.js';
import { brief } from './fixtures/brief.js';
import { figmaSource } from './fixtures/figma.js';

test.each([
  ['chat', false],
  ['responses', false],
  ['chat', true],
  ['responses', true],
] as const)(
  'Figma uses REST and real Mastra repository tools (%s, streaming: %s)',
  async (api, streaming) => {
    const directory = await mkdtemp(join(tmpdir(), 'darkfactory-figma-e2e-'));
    const repository = join(directory, 'repository');
    await mkdir(repository);
    const resultPath = join(directory, 'brief.json');
    await writeFile(resultPath, JSON.stringify(brief));
    const port = await availablePort();
    const config = factoryConfigSchema.parse({
      model: { api, baseUrl: `http://127.0.0.1:${port}/v1` },
      router: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./fixtures/router.mjs', import.meta.url)),
          String(port),
          resultPath,
          'delivery-figma',
        ],
      },
    });
    const controller = new AbortController();
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: repository }),
      sandbox: new LocalSandbox({ workingDirectory: repository, timeout: 0 }),
    });
    let router: Awaited<ReturnType<typeof startRouter>> | undefined;
    const originalFetch = globalThis.fetch;
    const restCalls: RequestInit[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => {
      if (input instanceof URL && input.hostname === 'api.figma.com') {
        if (options) restCalls.push(options);
        return Promise.resolve(
          Response.json({
            nodes: { '1:2': { document: { id: '1:2', type: 'FRAME' } } },
          }),
        );
      }
      return originalFetch(input, options);
    });
    try {
      router = await startRouter(
        config,
        'test-key',
        directory,
        controller.signal,
      );
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
        tools: { figma: tools.figma },
        signal: controller.signal,
        ...(streaming ? { debug: vi.fn() } : {}),
      });
      expect(result.blockers).toEqual([]);
      expect(result.components).toEqual(['ui-scaffold.tsx: Panel']);
      expect(await readFile(join(repository, 'ui-scaffold.tsx'), 'utf8')).toBe(
        'export const Panel = () => null;',
      );
      expect(restCalls).toHaveLength(1);
      expect(restCalls[0]?.headers).toEqual({
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
      await router?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
