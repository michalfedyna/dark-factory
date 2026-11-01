import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { afterEach, expect, test, vi } from 'vitest';
import { createFigma } from '../src/agents/figma.js';
import { generateResult } from '../src/agents/generation.js';
import { createImplementation } from '../src/agents/implementation.js';
import { createDocumentation } from '../src/agents/documentation.js';
import { dependencyInstructions } from '../src/agents/shared.js';
import { createIssueTask } from '../src/agents/task.js';
import { factoryConfigSchema } from '../src/config/schema.js';
import { implementationContext } from '../src/delivery/agent-context.js';
import { createFigmaTools } from '../src/tools/figma.js';
import { candidateState, projectPlan } from './fixtures/delivery.js';

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
  '%s receives current-version research and toolchain compatibility instructions',
  async (role) => {
    vi.mocked(generateResult).mockResolvedValue({});
    const model = factoryConfigSchema.parse({}).model;
    const directory = await mkdtemp(
      join(tmpdir(), 'darkfactory-agent-prompts-'),
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
    expect(agent.id).toBe(role);
    expect(await agent.getInstructions()).toContain(dependencyInstructions);
    expect(dependencyInstructions).toContain('latest stable');
    expect(dependencyInstructions).toContain('official package registries');
    expect(dependencyInstructions).toContain('actual target toolchain');
    expect(dependencyInstructions).toContain('Do not make unrelated upgrades');
    expect(dependencyInstructions).toContain(
      'call agent-documentation and wait',
    );
    expect(dependencyInstructions).toContain('preferred route');
    expect(dependencyInstructions).not.toContain('no dedicated web-search');
    const subagents = await agent.listAgents();
    expect(Object.keys(subagents)).toEqual(['documentation']);
    expect(await agent.listTools()).not.toHaveProperty('search_web');
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

test('documentation is a compact, source-backed, read-only research role', async () => {
  const observe = vi.fn();
  const agent = createDocumentation(
    factoryConfigSchema.parse({}).model,
    'test-key',
    observe,
  );
  expect(agent.id).toBe('documentation');
  expect(await agent.getWorkspace()).toBeUndefined();
  expect(Object.keys(await agent.listTools()).sort()).toEqual([
    'search_web',
    'web_fetch',
  ]);
  expect(await agent.listAgents()).toEqual({});
  const instructions = await agent.getInstructions();
  for (const text of [
    'no more than 600 words',
    'snippets alone are not verified documentation',
    'version-matched',
    'exact URLs read',
    'untrusted reference data',
    'never private code',
    'no repository, filesystem, shell',
    'insufficient evidence',
  ])
    expect(instructions).toContain(text);
});
