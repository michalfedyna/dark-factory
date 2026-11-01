import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LocalFilesystem,
  LocalSandbox,
  Workspace,
} from '@mastra/core/workspace';
import { expect, test, vi } from 'vitest';
import { createFigma } from '../src/agents/figma.js';
import { createImplementation } from '../src/agents/implementation.js';
import { createIssueTask } from '../src/agents/task.js';
import {
  progressTestRequestSchema,
  progressTestResultSchema,
} from '../src/contracts/progress-test.js';
import { implementationContext } from '../src/delivery/agent-context.js';
import { createProgressTestRunner } from '../src/delivery/progress-test.js';
import { createFigmaTools } from '../src/tools/figma.js';
import { createTestTool } from '../src/tools/test.js';
import { candidateState, png, projectPlan } from './fixtures/delivery.js';
import { availablePort } from './fixtures/integration.js';
import { createModelProvider } from './fixtures/model-provider.js';
import { createProgressTestResources } from './fixtures/progress-test.js';

async function setup() {
  const provider = await createModelProvider('chat', 'progress-test');
  const resources = await createProgressTestResources(provider.directory);
  vi.spyOn(globalThis, 'fetch').mockImplementation(provider.modelFetch);
  const port = await availablePort();
  const request = progressTestRequestSchema.parse({
    instructions: 'Inspect the current presentation.',
    target: {
      id: 'web',
      kind: 'web',
      url: `http://127.0.0.1:${port}`,
      start: {
        command: process.execPath,
        args: [
          '-e',
          `require('node:http').createServer((_req, res) => res.end(require('node:fs').readFileSync('progress.txt'))).listen(${port}, '127.0.0.1')`,
        ],
      },
    },
  });
  const run = createProgressTestRunner(resources.run, {
    model: provider.config.model,
    apiKey: 'test-key',
  });
  const tool = createTestTool({ run, signal: provider.controller.signal });
  return {
    provider,
    resources,
    request,
    tool,
    close: async () => {
      await resources.close();
      await provider.close();
    },
  };
}

test.each(['implementation', 'figma'] as const)(
  '%s can call test and receive progress feedback without granting repository access to the tester',
  async (role) => {
    const { provider, resources, request, tool, close } = await setup();
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: resources.repository }),
    });
    const state = candidateState();
    state.brief.problem = 'Private task context';
    const originalState = structuredClone(state);
    const destroy = vi.spyOn(LocalSandbox.prototype, 'destroy');
    if (role === 'figma') {
      request.target = {
        id: 'ios',
        kind: 'mobile',
        platform: 'ios',
        app: 'com.example.progress',
        screenshots: false,
        prepare: {
          command: process.execPath,
          args: [
            '-e',
            "require('node:fs').writeFileSync('prepared.txt', require('node:fs').readFileSync('progress.txt'))",
          ],
        },
      };
    }
    await writeFile(
      join(provider.directory, 'progress-test.json'),
      JSON.stringify(request),
    );
    try {
      const input = {
        workspace,
        signal: provider.controller.signal,
        tools: { test: tool },
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
                test: tool,
                figma: createFigmaTools({
                  sources: [],
                  token: '',
                  auth: 'personal',
                  signal: input.signal,
                }).figma,
              },
              observe: () => {},
            });
      expect(result.summary).toBe('Tested progress.');
      const parentReply = JSON.stringify(provider.modelRequests.at(-1));
      expect(parentReply).toContain('Observed current progress.');
      if (role === 'implementation') {
        expect(parentReply).toContain(
          `data:image/png;base64,${png.toString('base64')}`,
        );
        await expect(
          fetch(request.target.kind === 'web' ? request.target.url : ''),
        ).rejects.toThrow();
      } else {
        expect(parentReply).not.toContain('data:image');
        expect(
          await readFile(join(resources.repository, 'prepared.txt'), 'utf8'),
        ).toBe('Current progress');
      }
      const contexts = (
        await readFile(join(provider.directory, 'agent-contexts.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              role: string;
              tools: string[];
              payload: unknown;
            },
        );
      const tester = contexts.find(
        (context) => context.role === 'progress-test',
      );
      expect(tester?.tools).toEqual([
        role === 'implementation' ? 'agent_browser' : 'agent_device',
      ]);
      expect(JSON.stringify(tester?.payload)).not.toContain(
        'Private task context',
      );
      expect(state).toEqual(originalState);
      expect(await readdir(resources.run.directory)).toEqual([
        'progress-tests',
      ]);
      const tests = await readdir(
        join(resources.run.directory, 'progress-tests'),
      );
      expect(tests).toHaveLength(1);
      const logs = await readdir(
        join(resources.run.directory, 'progress-tests', tests[0]!),
      );
      expect(logs).toContain('r0-e1.json');
      expect(destroy).toHaveBeenCalledOnce();
      expect(destroy.mock.contexts[0]).not.toBe(
        resources.run.automationSandbox,
      );
    } finally {
      await workspace.destroy();
      await close();
    }
  },
);

test.each(['prepare', 'start'] as const)(
  'failed target %s returns command diagnostics without running a tester',
  async (phase) => {
    const { provider, request, tool, close } = await setup();
    const command = {
      command: process.execPath,
      args: ['-e', "console.error('Missing prerequisite'); process.exit(7)"],
    };
    request.target =
      phase === 'start'
        ? {
            ...request.target,
            kind: 'web',
            url: 'http://127.0.0.1:1',
            start: command,
          }
        : {
            id: 'ios',
            kind: 'mobile',
            platform: 'ios',
            app: 'com.example.progress',
            screenshots: false,
            prepare: command,
          };
    try {
      const result = progressTestResultSchema.parse(
        await tool.execute!(request, {}),
      );
      expect(result).toMatchObject({ status: 'blocked', screenshots: [] });
      expect(result.description).toContain('Missing prerequisite');
      expect(provider.modelRequests).toEqual([]);
    } finally {
      await close();
    }
  },
);

test('cancellation before testing acquires no sandbox or artifacts', async () => {
  const { provider, resources, request, tool, close } = await setup();
  const destroy = vi.spyOn(LocalSandbox.prototype, 'destroy');
  provider.controller.abort(new Error('Cancelled before test'));
  try {
    await expect(tool.execute!(request, {})).rejects.toThrow(
      'Cancelled before test',
    );
    expect(provider.modelRequests).toEqual([]);
    expect(destroy).not.toHaveBeenCalled();
    expect(await readdir(resources.run.directory)).toEqual([]);
  } finally {
    await close();
  }
});

test('cancellation during a test stops its server and preserves the cancellation', async () => {
  const { provider, resources, request, tool, close } = await setup();
  let testing: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    testing = resolve;
  });
  vi.mocked(fetch).mockImplementation((input, options) => {
    if (
      typeof options?.body === 'string' &&
      options.body.includes('"name":"agent_browser"')
    ) {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => reject(new Error('Testing cancelled')),
          { once: true },
        );
        testing();
      });
    }
    return provider.modelFetch(input, options);
  });
  const destroy = vi.spyOn(LocalSandbox.prototype, 'destroy');
  try {
    const running = tool.execute!(request, {});
    const rejected = expect(running).rejects.toThrow('Cancelled during test');
    await started;
    provider.controller.abort(new Error('Cancelled during test'));
    await rejected;
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy.mock.contexts[0]).not.toBe(resources.run.automationSandbox);
    if (request.target.kind === 'web')
      await expect(fetch(request.target.url)).rejects.toThrow();
  } finally {
    await close();
  }
});
