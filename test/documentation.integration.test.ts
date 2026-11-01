import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { expect, test, vi } from 'vitest';
import { createFigma } from '../src/agents/figma.js';
import { createImplementation } from '../src/agents/implementation.js';
import { createIssueTask } from '../src/agents/task.js';
import { implementationContext } from '../src/delivery/agent-context.js';
import { createFigmaTools } from '../src/tools/figma.js';
import { webFetchTool } from '../src/tools/web-fetch.js';
import { candidateState, projectPlan } from './fixtures/delivery.js';
import { createModelProvider } from './fixtures/model-provider.js';

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof URL
    ? input.href
    : typeof input === 'string'
      ? input
      : input.url;
}

test.each([
  ['implementation', 'chat', false],
  ['implementation', 'responses', false],
  ['implementation', 'chat', true],
  ['implementation', 'responses', true],
  ['figma', 'chat', false],
  ['figma', 'responses', true],
] as const)(
  '%s delegates documentation through native Mastra tools (%s, streaming: %s)',
  async (role, api, streaming) => {
    const provider = await createModelProvider(api, 'documentation');
    const repository = join(provider.directory, 'repository');
    await mkdir(repository);
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: repository }),
    });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, options) => {
        if (requestUrl(input).startsWith('https://html.duckduckgo.com/html/'))
          return Promise.resolve(
            new Response(
              '<div class="result"><a class="result__a" href="https://docs.example.com/widgets">Widgets docs</a></div>',
            ),
          );
        return provider.modelFetch(input, options);
      });
    const readPage = vi.spyOn(webFetchTool, 'execute').mockResolvedValue({
      content: 'import { createWidget } from "widgets"; createWidget(options)',
      ok: true,
    });
    const observe = vi.fn();
    const debug = vi.fn();
    const signal = provider.controller.signal;
    const state = candidateState();
    state.brief.problem =
      'Private task details must not enter documentation context.';
    try {
      const input = {
        workspace,
        signal,
        observe,
        ...(streaming ? { debug } : {}),
      };
      const result =
        role === 'implementation'
          ? await createImplementation(
              provider.config.model,
              'test-key',
            )({
              ...input,
              context: implementationContext(state, projectPlan, []),
            })
          : await createFigma(
              provider.config.model,
              'test-key',
            )({
              ...input,
              context: {
                task: createIssueTask(state.brief),
                allowedPaths: ['.'],
                sources: [],
              },
              tools: {
                figma: createFigmaTools({
                  sources: [],
                  token: '',
                  auth: 'personal',
                  signal,
                }).figma,
              },
            });
      expect(result.summary).toBe('Consulted the documentation guide.');
      expect(readPage).toHaveBeenCalledOnce();
      expect(
        fetch.mock.calls.filter(([url]) =>
          requestUrl(url).includes('duckduckgo.com'),
        ),
      ).toHaveLength(1);
      const requests = provider.modelRequests.map((request) =>
        JSON.stringify(request),
      );
      const childRequests = requests.filter((request) =>
        request.includes('"name":"search_web"'),
      );
      expect(childRequests).toHaveLength(3);
      expect(childRequests.at(-1)).toContain('Widgets documentation');
      for (const request of childRequests) {
        expect(request).toContain('widgets');
        expect(request).not.toContain('Private task details');
        expect(request).not.toContain('mastra_workspace_');
        expect(request).not.toContain('agent-documentation');
      }
      const cleanupRequests = requests.filter((request) =>
        request.includes('\\"searchResults\\"'),
      );
      expect(cleanupRequests).toHaveLength(1);
      expect(cleanupRequests[0]).not.toContain('Private task details');
      expect(cleanupRequests[0]).not.toContain('mastra_workspace_');
      expect(cleanupRequests[0]).not.toContain('"name":"search_web"');
      const parentReply = requests.at(-1)!;
      expect(parentReply).toContain('import createWidget');
      expect(parentReply).not.toContain('Widgets docs');
      expect(parentReply).not.toContain('createWidget(options)');
      expect(observe).toHaveBeenCalledWith({
        kind: 'tool',
        agent: 'documentation',
        tool: 'search_web',
        status: 'started',
      });
    } finally {
      await workspace.destroy();
      await provider.close();
    }
  },
);

test.each(['chat', 'responses'] as const)(
  'cancellation reaches a delegated search request (%s)',
  async (api) => {
    const provider = await createModelProvider(api, 'documentation');
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: provider.directory }),
    });
    let searching: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      searching = resolve;
    });
    let searchSignal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => {
      if (requestUrl(input).startsWith('https://html.duckduckgo.com/html/')) {
        searchSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          searchSignal?.addEventListener(
            'abort',
            () => reject(new Error('Search request cancelled')),
            { once: true },
          );
          searching();
        });
      }
      return provider.modelFetch(input, options);
    });
    const readPage = vi.spyOn(webFetchTool, 'execute');
    try {
      const running = createImplementation(
        provider.config.model,
        'test-key',
      )({
        context: implementationContext(candidateState(), projectPlan, []),
        workspace,
        signal: provider.controller.signal,
      });
      const rejected = expect(running).rejects.toThrow(
        'Cancelled documentation',
      );
      await started;
      provider.controller.abort(new Error('Cancelled documentation'));
      await rejected;
      expect(searchSignal?.aborted).toBe(true);
      expect(readPage).not.toHaveBeenCalled();
    } finally {
      await workspace.destroy();
      await provider.close();
    }
  },
);
