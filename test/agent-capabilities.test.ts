import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { afterEach, expect, test, vi } from 'vitest';
import { createFigma } from '../src/agents/figma.js';
import { generateResult } from '../src/agents/generation.js';
import { createImplementation } from '../src/agents/implementation.js';
import { createDocumentation } from '../src/agents/documentation.js';
import { createIssueTask } from '../src/agents/task.js';
import { factoryConfigSchema } from '../src/config/schema.js';
import { implementationContext } from '../src/delivery/agent-context.js';
import { createFigmaTools } from '../src/tools/figma.js';
import { candidateState, projectPlan } from './fixtures/delivery.js';
import { unusedTestTool } from './fixtures/progress-test.js';

vi.mock('../src/agents/generation.js');
const workspaces: Workspace[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((workspace) => workspace.destroy()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test.each(['implementation', 'figma'] as const)(
  '%s exposes progress testing and isolates documentation research',
  async (role) => {
    vi.mocked(generateResult).mockResolvedValue({});
    const model = factoryConfigSchema.parse({}).model;
    const directory = await mkdtemp(
      join(tmpdir(), 'darkfactory-capabilities-'),
    );
    directories.push(directory);
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: directory }),
    });
    workspaces.push(workspace);
    const signal = new AbortController().signal;
    const state = candidateState();
    if (role === 'implementation')
      await createImplementation(
        model,
        'test-key',
      )({
        context: implementationContext(state, projectPlan, []),
        workspace,
        tools: { test: unusedTestTool(signal) },
        signal,
      });
    else
      await createFigma(
        model,
        'test-key',
      )({
        context: {
          task: createIssueTask(state.brief),
          allowedPaths: projectPlan.allowedPaths,
          sources: [],
        },
        tools: {
          test: unusedTestTool(signal),
          figma: createFigmaTools({
            sources: [],
            token: '',
            auth: 'personal',
            signal,
          }).figma,
        },
        workspace,
        signal,
      });
    const agent = vi.mocked(generateResult).mock.calls.at(-1)?.[0];
    if (!agent) throw new Error('Agent generation was not called.');
    expect(Object.keys(await agent.listAgents())).toEqual(['documentation']);
    expect(await agent.listTools()).not.toHaveProperty('search_web');
    expect(await agent.listTools()).toHaveProperty('test');
    const options = await agent.getDefaultOptions();
    expect(
      options.delegation?.messageFilter?.({
        messages: [{ role: 'user', content: 'private repository context' }],
        primitiveId: 'documentation',
        primitiveType: 'agent',
        prompt: 'Public library question',
        iteration: 1,
        runId: 'run',
        parentAgentId: role,
        parentAgentName: role,
        toolCallId: 'call',
      }),
    ).toEqual([]);
    expect(options.delegation?.hookErrorStrategy).toBe('throw');
  },
);

test('documentation exposes only public research tools, without a workspace or subagents', async () => {
  const agent = createDocumentation(
    factoryConfigSchema.parse({}).model,
    'test-key',
  );
  expect(await agent.getWorkspace()).toBeUndefined();
  expect(Object.keys(await agent.listTools()).sort()).toEqual([
    'search_web',
    'web_fetch',
  ]);
  expect(await agent.listAgents()).toEqual({});
});
