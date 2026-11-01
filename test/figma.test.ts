import { expect, test, vi } from 'vitest';
import { findFigmaSources } from '../src/integrations/figma/sources.js';
import { scaffoldUi } from '../src/delivery/steps.js';
import { implementationContext } from '../src/delivery/agent-context.js';
import {
  createFigmaClient,
  figmaRequestSchema,
} from '../src/integrations/figma/client.js';
import { createFigmaTools } from '../src/tools/figma.js';
import { candidateState, projectPlan } from './fixtures/delivery.js';
import { figmaResult, figmaSource } from './fixtures/figma.js';
import { createWorkflowSetup, qaPass } from './fixtures/workflow.js';

test('extracts and deduplicates canonical file, design, prototype, branch and version references', () => {
  const sources = findFigmaSources(
    '[Design](https://www.figma.com/design/DesignKey/Screen?node-id=1-2&t=tracking),',
    'https://figma.com/file/DesignKey/Old?node-id=1%3A2',
    JSON.stringify({
      reference:
        'https://figma.com/proto/OtherKey/Page?version-id=12&node-id=3-4',
    }),
    'https://www.figma.com/design/MainKey/branch/BranchKey/Screen',
  );
  expect(sources).toEqual([
    figmaSource,
    {
      fileKey: 'OtherKey',
      nodeId: '3:4',
      version: '12',
      url: 'https://www.figma.com/design/OtherKey?node-id=3%3A4&version-id=12',
    },
    {
      fileKey: 'BranchKey',
      nodeId: null,
      version: null,
      url: 'https://www.figma.com/design/BranchKey',
    },
  ]);
});

test.each([
  'https://figma.com.evil.test/design/key/Screen',
  'https://evil.test/figma.com/design/key/Screen',
  'http://www.figma.com/design/key/Screen',
  'https://www.figma.com/community/file/key',
  'https://www.figma.com/design/../secrets',
  'https://www.figma.com/design/key/Screen?node-id=%2Fetc%2Fpasswd',
])('ignores unsupported or lookalike references: %s', (url) => {
  expect(findFigmaSources(url)).toEqual([]);
});

test('Figma runs once before implementation, preserving original issue links omitted by exploration', async () => {
  const { options, operations, run } = createWorkflowSetup();
  options.issue =
    'Implement https://www.figma.com/design/DesignKey/Screen?node-id=1-2';
  operations.qa.mockResolvedValueOnce({
    ...qaPass,
    verdict: 'changes-requested',
    criteria: [{ ...qaPass.criteria[0], status: 'fail' }],
  });
  await expect(run()).resolves.toMatchObject({ status: 'ready', rounds: 2 });
  expect(operations.figma).toHaveBeenCalledOnce();
  expect(operations.figma.mock.invocationCallOrder[0]).toBeLessThan(
    operations.implement.mock.invocationCallOrder[0]!,
  );
  expect(operations.figma.mock.calls[0]?.[0].figma).toEqual({
    sources: [figmaSource],
    result: null,
  });
  for (const [state] of operations.implement.mock.calls)
    expect(state.figma?.result?.implementationNotes).toEqual([
      'Wire the export callback.',
    ]);
});

test('issues without Figma links skip the UI agent', async () => {
  const { operations, run } = createWorkflowSetup();
  await expect(run()).resolves.toMatchObject({ status: 'ready' });
  expect(operations.figma).not.toHaveBeenCalled();
});

test('Figma links supplied during exploration also trigger UI scaffolding', async () => {
  const { brief } = candidateState();
  const { run, operations } = createWorkflowSetup(() =>
    Promise.resolve({
      ...brief,
      decisions: [{ question: 'Design reference?', answer: figmaSource.url }],
    }),
  );
  await run();
  expect(operations.figma.mock.calls[0]?.[0].figma?.sources).toEqual([
    figmaSource,
  ]);
});

test('a design blocker stops before implementation, capture and QA without consuming a repair round', async () => {
  const { options, operations, run, close } = createWorkflowSetup();
  options.issue = figmaSource.url;
  operations.figma.mockResolvedValue({
    ...figmaResult,
    blockers: ['The design is inaccessible.'],
  });
  await expect(run()).resolves.toMatchObject({
    status: 'blocked',
    rounds: 0,
    reason: 'The design is inaccessible.',
    revision: null,
  });
  for (const operation of [
    operations.implement,
    operations.capture,
    operations.checks,
    operations.qa,
    operations.review,
    operations.summarize,
  ])
    expect(operation).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

test('invalid design handoffs cannot advance implementation', async () => {
  const { options, operations, run } = createWorkflowSetup();
  options.issue = figmaSource.url;
  operations.figma.mockResolvedValue({ summary: 'Done' });
  await expect(run()).rejects.toThrow('Workflow failed');
  expect(operations.implement).not.toHaveBeenCalled();
});

test('a late Figma result cannot advance a cancelled workflow', async () => {
  const { operations } = createWorkflowSetup();
  const controller = new AbortController();
  const state = {
    ...candidateState(),
    round: 0,
    history: [],
    figma: { sources: [figmaSource], result: null },
  };
  operations.figma.mockImplementationOnce(() => {
    controller.abort(new Error('Cancelled'));
    return Promise.resolve(figmaResult);
  });
  await expect(
    scaffoldUi(state, operations, controller.signal),
  ).rejects.toThrow('Cancelled');
  expect(state.figma.result).toBeNull();
});

test('implementation receives the UI handoff on initial work and repairs, not API credentials or tool data', () => {
  const state = candidateState();
  state.figma = { sources: [figmaSource], result: figmaResult };
  const context = implementationContext(state, projectPlan, []);
  expect(context.figma).toEqual(state.figma);
  expect(Object.keys(context.figma!).sort()).toEqual(['result', 'sources']);
});

function toolSetup(sources = [figmaSource]) {
  const controller = new AbortController();
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      nodes: {
        '1:2': { document: { id: '1:2', type: 'FRAME', name: 'Export' } },
      },
    }),
  );
  const tools = createFigmaTools({
    sources,
    token: 'private-figma-token',
    auth: 'personal',
    signal: controller.signal,
  });
  const execute = (
    input: Parameters<NonNullable<typeof tools.figma.execute>>[0],
    signal?: AbortSignal,
  ) => tools.figma.execute!(input, signal ? { abortSignal: signal } : {});
  const input = {
    source: sources[0]!.url,
    operation: 'nodes' as const,
    nodeIds: ['1:2'],
    format: 'png' as const,
  };
  return { tools, execute, input, fetch, controller };
}

test('Figma tools use only the REST host, keep credentials in headers, and track actual source reads', async () => {
  const { tools, execute, input, fetch } = toolSetup();
  expect(tools.unreadSources()).toEqual([figmaSource]);
  await expect(execute(input)).resolves.toMatchObject({ previews: [] });
  const [url, options] = fetch.mock.calls[0]!;
  expect(url).toEqual(
    new URL('https://api.figma.com/v1/files/DesignKey/nodes?ids=1%3A2'),
  );
  expect(options).toMatchObject({
    method: 'GET',
    redirect: 'error',
    headers: { 'X-Figma-Token': 'private-figma-token' },
  });
  expect(tools.unreadSources()).toEqual([]);
});

test('the tool rejects unapproved sources before sending credentials anywhere', async () => {
  const { execute, input, fetch } = toolSetup();
  await expect(
    execute({ ...input, source: 'https://evil.test/design/key' }),
  ).rejects.toThrow('supplied Figma source');
  expect(fetch).not.toHaveBeenCalled();
});

test.each(['nodes', 'render'] as const)(
  '%s requires explicit node IDs',
  async (operation) => {
    const { execute, input, fetch } = toolSetup();
    await expect(execute({ ...input, operation, nodeIds: [] })).rejects.toThrow(
      'require nodeIds',
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

test('file discovery is shallow by default and OAuth credentials use the Bearer header', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ document: { id: '0:0' } }));
  const read = createFigmaClient('oauth-token', 'oauth');
  await read(
    { ...figmaSource, version: '123' },
    figmaRequestSchema.parse({ operation: 'file' }),
    new AbortController().signal,
  );
  expect(fetch.mock.calls[0]?.[0]).toEqual(
    new URL('https://api.figma.com/v1/files/DesignKey?version=123&depth=2'),
  );
  expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
    Authorization: 'Bearer oauth-token',
  });
});

test.each([
  ['image-fills', '/images'],
  ['components', '/components'],
  ['component-sets', '/component_sets'],
  ['styles', '/styles'],
  ['variables', '/variables/local'],
] as const)(
  'exposes read-only %s data without pretending metadata is versioned',
  async (operation, suffix) => {
    const { execute, input, fetch } = toolSetup([
      { ...figmaSource, version: '123' },
    ]);
    fetch.mockResolvedValueOnce(Response.json({ meta: {} }));
    await execute({ ...input, operation });
    expect(fetch.mock.calls[0]?.[0]).toEqual(
      new URL(`https://api.figma.com/v1/files/DesignKey${suffix}`),
    );
  },
);

test('PNG renders include visual previews, while SVG exports remain text references', async () => {
  const { tools, execute, input, fetch } = toolSetup([
    { ...figmaSource, version: '123' },
  ]);
  const url = 'https://figma-images.example.test/export.png';
  fetch.mockImplementation(() =>
    Promise.resolve(Response.json({ images: { '1:2': url } })),
  );
  const result = await execute({ ...input, operation: 'render' });
  expect(result).toMatchObject({ previews: [url] });
  expect(fetch.mock.calls[0]?.[0]).toEqual(
    new URL(
      'https://api.figma.com/v1/images/DesignKey?version=123&ids=1%3A2&format=png',
    ),
  );
  expect(tools.figma.toModelOutput!({ data: {}, previews: [url] })).toEqual({
    type: 'content',
    value: [
      { type: 'text', text: '{}' },
      { type: 'image-url', url },
    ],
  });
  await expect(
    execute({ ...input, operation: 'render', format: 'svg' }),
  ).resolves.toMatchObject({ previews: [] });
  expect(tools.unreadSources()).toHaveLength(1);
});

test.each([401, 403, 404, 429, 500])(
  'REST %s errors are actionable without echoing response bodies or credentials',
  async (status) => {
    const { execute, input, fetch, tools } = toolSetup();
    fetch.mockResolvedValueOnce(
      new Response('private-figma-token upstream diagnostics', { status }),
    );
    const pending = execute(input);
    await expect(pending).rejects.toThrow(`Figma REST ${status}`);
    await expect(pending).rejects.not.toThrow('private-figma-token');
    expect(tools.unreadSources()).toEqual([figmaSource]);
  },
);

test.each([
  { nodes: { '1:2': null } },
  { nodes: { '1:2': {} } },
  { nodes: { '1:2': { document: {} } } },
  { nodes: {} },
  { err: 'private-figma-token upstream diagnostics' },
  [],
])(
  'invalid or missing node data cannot mark a source inspected: %j',
  async (data) => {
    const { execute, input, fetch, tools } = toolSetup();
    fetch.mockResolvedValueOnce(Response.json(data));
    await expect(execute(input)).rejects.toThrow('Figma REST');
    expect(tools.unreadSources()).toHaveLength(1);
  },
);

test('reading other nodes or file metadata cannot satisfy a specific linked node', async () => {
  const { execute, input, tools, fetch } = toolSetup();
  fetch.mockResolvedValueOnce(Response.json({ document: { id: '0:0' } }));
  await execute({ ...input, operation: 'file' });
  expect(tools.unreadSources()).toHaveLength(1);
  fetch.mockResolvedValueOnce(
    Response.json({ nodes: { '3:4': { document: { id: '3:4' } } } }),
  );
  await execute({ ...input, nodeIds: ['3:4'] });
  expect(tools.unreadSources()).toHaveLength(1);
});

test('whole-file sources require a successful file read', async () => {
  const source = { ...figmaSource, nodeId: null };
  const { execute, input, tools, fetch } = toolSetup([source]);
  fetch.mockResolvedValueOnce(Response.json({ document: { id: '0:0' } }));
  await execute({ ...input, operation: 'file' });
  expect(tools.unreadSources()).toEqual([]);
});

test.each(['run', 'tool'] as const)(
  'cancellation from the %s signal prevents REST work',
  async (scope) => {
    const { execute, input, fetch, controller } = toolSetup();
    const toolController = new AbortController();
    (scope === 'run' ? controller : toolController).abort(
      new Error('Cancelled'),
    );
    await expect(execute(input, toolController.signal)).rejects.toThrow(
      'Cancelled',
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

test('network errors do not leak request headers and late cancellation never records a read', async () => {
  const { execute, input, fetch, controller, tools } = toolSetup();
  fetch.mockRejectedValueOnce(new Error('private-figma-token in request'));
  await expect(execute(input)).rejects.toThrow('Check network access');
  fetch.mockImplementationOnce(() => {
    controller.abort(new Error('Cancelled'));
    return Promise.resolve(Response.json({ nodes: { '1:2': {} } }));
  });
  await expect(execute(input)).rejects.toThrow('Cancelled');
  expect(tools.unreadSources()).toHaveLength(1);
});
