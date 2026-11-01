import { expect, test, vi } from 'vitest';
import { downloadFigmaPng } from '../src/integrations/figma/images.js';
import { createFigmaPreviewTools } from '../src/tools/figma-preview.js';
import { png } from './fixtures/delivery.js';
import { figmaSource } from './fixtures/figma.js';

const cdnUrl =
  'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/export.png';
const suppliedUrl =
  'https://www.figma.com/design/DesignKey/Screen?node-id=1-2&t=tracking';

function setup(sources = [figmaSource], token = 'private-figma-token') {
  const controller = new AbortController();
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    if (input instanceof URL && input.hostname === 'api.figma.com')
      return Promise.resolve(Response.json({ images: { '1:2': cdnUrl } }));
    return Promise.resolve(new Response(new Uint8Array(png)));
  });
  const tools = createFigmaPreviewTools({
    sources,
    token,
    tokenEnv: 'FIGMA_TEST_TOKEN',
    auth: 'personal',
    signal: controller.signal,
  });
  const input = {
    source: suppliedUrl,
    operation: 'preview' as const,
    nodeIds: [],
  };
  return { controller, fetch, tools, input };
}

test('linked designs export directly to PNG without fetching implementation details', async () => {
  const { tools, fetch, input } = setup();
  const result = await tools.figma.execute!(input, {});
  expect(result).toEqual({
    frames: [],
    previews: [{ nodeId: '1:2', image: png.toString('base64') }],
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[0]).toEqual(
    new URL('https://api.figma.com/v1/images/DesignKey?ids=1%3A2&format=png'),
  );
  expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
    'X-Figma-Token': 'private-figma-token',
  });
  expect(fetch.mock.calls[1]?.[0]).toEqual(new URL(cdnUrl));
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({ redirect: 'error' });
  expect(fetch.mock.calls[1]?.[1]).not.toHaveProperty('headers');
  expect(
    tools.figma.toModelOutput!({
      frames: [],
      previews: [{ nodeId: '1:2', image: png.toString('base64') }],
    }),
  ).toEqual({
    type: 'content',
    value: [
      {
        type: 'text',
        text: JSON.stringify({ frames: [], previewNodeIds: ['1:2'] }),
      },
      { type: 'media', data: png.toString('base64'), mediaType: 'image/png' },
    ],
  });
});

test('whole-file discovery returns only screen IDs and names, not API specifications', async () => {
  const { tools, input, fetch } = setup([{ ...figmaSource, nodeId: null }]);
  fetch.mockResolvedValueOnce(
    Response.json({
      document: {
        id: '0:0',
        children: [
          {
            id: '0:1',
            name: 'Page',
            styles: { secret: 'details' },
            children: [
              {
                id: '1:2',
                name: 'Export',
                fills: ['colors'],
                absoluteBoundingBox: { width: 1024 },
                children: [{ id: '1:3', name: 'Button' }],
              },
            ],
          },
        ],
      },
      components: { internal: 'component details' },
      styles: { internal: 'token details' },
    }),
  );
  await expect(
    tools.figma.execute!(
      { ...input, source: figmaSource.url, operation: 'frames' },
      {},
    ),
  ).resolves.toEqual({ frames: [{ id: '1:2', name: 'Export' }], previews: [] });
  expect(fetch.mock.calls[0]?.[0]).toEqual(
    new URL('https://api.figma.com/v1/files/DesignKey?depth=2'),
  );
});

test('whole-file previews require chosen screen IDs and stay PNG-only', async () => {
  const source = {
    ...figmaSource,
    url: 'https://www.figma.com/design/DesignKey',
    nodeId: null,
  };
  const { tools, input, fetch } = setup([source]);
  await expect(
    tools.figma.execute!({ ...input, source: source.url }, {}),
  ).rejects.toThrow('Use frames');
  expect(fetch).not.toHaveBeenCalled();
  await expect(
    tools.figma.execute!(
      { ...input, source: source.url, nodeIds: ['1:2'] },
      {},
    ),
  ).resolves.toMatchObject({ frames: [] });
  expect(fetch.mock.calls[0]?.[0]).toEqual(
    new URL('https://api.figma.com/v1/images/DesignKey?ids=1%3A2&format=png'),
  );
});

test.each(['nodes', 'file', 'styles', 'variables', 'components', 'render'])(
  'exploration cannot request detailed %s data',
  async (operation) => {
    const { tools, input } = setup();
    expect(
      await tools.figma.inputSchema!['~standard'].validate({
        ...input,
        operation,
      }),
    ).toHaveProperty('issues');
  },
);

test.each([
  { format: 'svg' },
  { depth: 20 },
  { nodeIds: ['1:1', '1:2', '1:3', '1:4', '1:5'] },
])(
  'preview parameters cannot expand the lightweight tool: %j',
  async (extra) => {
    const { tools, input } = setup();
    expect(
      await tools.figma.inputSchema!['~standard'].validate({
        ...input,
        ...extra,
      }),
    ).toHaveProperty('issues');
  },
);

test('only explicitly added user references extend one preview session', async () => {
  const { tools, input, fetch } = setup([]);
  const other = setup([]).tools;
  await expect(tools.figma.execute!(input, {})).rejects.toThrow(
    'supplied Figma source',
  );
  expect(fetch).not.toHaveBeenCalled();
  tools.addSources([figmaSource]);
  await expect(tools.figma.execute!(input, {})).resolves.toMatchObject({
    frames: [],
  });
  await expect(other.figma.execute!(input, {})).rejects.toThrow(
    'supplied Figma source',
  );
});

test('missing credentials identify the configured environment variable without sending a request', async () => {
  const { tools, input, fetch } = setup([figmaSource], '');
  await expect(tools.figma.execute!(input, {})).rejects.toThrow(
    'Set FIGMA_TEST_TOKEN',
  );
  expect(fetch).not.toHaveBeenCalled();
});

test.each(['run', 'tool'] as const)(
  'PNG preview work respects %s cancellation',
  async (scope) => {
    const { tools, input, controller, fetch } = setup();
    const toolController = new AbortController();
    (scope === 'run' ? controller : toolController).abort(
      new Error('Cancelled'),
    );
    await expect(
      tools.figma.execute!(input, { abortSignal: toolController.signal }),
    ).rejects.toThrow('Cancelled');
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each([
  'http://s3-alpha-sig.figma.com/preview.png',
  'https://localhost/preview.png',
  'https://figma.com.evil.test/preview.png',
  'https://unrelated-bucket.s3.us-west-2.amazonaws.com/preview.png',
  'https://s3-alpha-sig.figma.com:8443/preview.png',
  'https://user:password@s3-alpha-sig.figma.com/preview.png',
])(
  'PNG downloads reject unsupported asset hosts without a network call: %s',
  async (url) => {
    const { fetch, controller } = setup();
    await expect(downloadFigmaPng(url, controller.signal)).rejects.toThrow(
      'supported Figma CDN',
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each(['not-png', 'too-large', 'http-error', 'network-error'] as const)(
  'invalid PNG exports fail safely: %s',
  async (failure) => {
    const { fetch, controller } = setup();
    if (failure === 'not-png')
      fetch.mockResolvedValueOnce(new Response('not an image'));
    else if (failure === 'too-large')
      fetch.mockResolvedValueOnce(
        new Response(new Uint8Array(10 * 1024 * 1024 + 1)),
      );
    else if (failure === 'http-error')
      fetch.mockResolvedValueOnce(
        new Response('private signed URL', { status: 403 }),
      );
    else fetch.mockRejectedValueOnce(new Error('private signed URL'));
    const pending = downloadFigmaPng(cdnUrl, controller.signal);
    await expect(pending).rejects.toThrow('Figma');
    await expect(pending).rejects.not.toThrow('private signed URL');
  },
);
