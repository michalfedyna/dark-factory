import { expect, test, vi } from 'vitest';
import { createSearchCleanup } from '../src/agents/search-cleanup.js';
import { factoryConfigSchema } from '../src/config/schema.js';
import type { SearchResult } from '../src/contracts/web-search.js';

const sources: SearchResult[] = [
  {
    title: 'Widgets docs',
    url: 'https://docs.example.com/widgets',
    snippet: 'Home | Use widgets & options.',
  },
  { title: 'API', url: 'https://docs.example.com/api?version=1', snippet: '' },
];

function setup(object: unknown) {
  const cleanup = createSearchCleanup(
    factoryConfigSchema.parse({}).model,
    'test-key',
  );
  const generate = vi.spyOn(cleanup.agent, 'generate').mockResolvedValue({
    object,
  } as Awaited<ReturnType<typeof cleanup.agent.generate>>);
  return { ...cleanup, generate };
}

test('cleanup returns plain text while preserving source URLs, ranking and absent snippets', async () => {
  const cleanup = setup({
    results: [
      { index: 1, title: 'API', snippet: 'Invented snippet' },
      {
        index: 0,
        title: '<b>Widgets</b> &amp; documentation',
        snippet:
          'Use <code>widgets</code> &amp; options. <script>bad()</script><style>.hidden {}</style><!-- hidden -->',
      },
    ],
  });
  const signal = new AbortController().signal;
  expect(await cleanup.clean(sources, signal)).toEqual([
    {
      title: 'Widgets & documentation',
      url: sources[0]!.url,
      snippet: 'Use widgets & options.',
    },
    { title: 'API', url: sources[1]!.url, snippet: '' },
  ]);
  const [message] = cleanup.generate.mock.calls[0]!;
  expect(JSON.parse(message as string)).toEqual({
    searchResults: sources.map(({ title, snippet }, index) => ({
      index,
      title,
      snippet,
    })),
  });
  expect(cleanup.generate).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ abortSignal: signal }),
  );
});

test.each([
  ['invalid structure', { text: 'not structured results' }],
  [
    'missing result',
    { results: [{ index: 0, title: 'Widgets', snippet: '' }] },
  ],
  [
    'duplicate index',
    {
      results: [
        { index: 0, title: 'Widgets', snippet: '' },
        { index: 0, title: 'API', snippet: '' },
      ],
    },
  ],
  [
    'unknown index',
    {
      results: [
        { index: 0, title: 'Widgets', snippet: '' },
        { index: 2, title: 'API', snippet: '' },
      ],
    },
  ],
  [
    'invented URL',
    {
      results: [
        {
          index: 0,
          title: 'Widgets',
          snippet: '',
          url: 'https://invented.example.com',
        },
        { index: 1, title: 'API', snippet: '' },
      ],
    },
  ],
  [
    'HTML-only title',
    {
      results: [
        { index: 0, title: '<script>bad()</script>', snippet: '' },
        { index: 1, title: 'API', snippet: '' },
      ],
    },
  ],
])(
  'cleanup rejects %s rather than publishing invalid search data',
  async (_name, output) => {
    const cleanup = setup(output);
    await expect(cleanup.clean(sources)).rejects.toThrow();
  },
);

test('cleanup discards model output that arrives after cancellation', async () => {
  const cleanup = setup(undefined);
  const controller = new AbortController();
  cleanup.generate.mockImplementation(() => {
    controller.abort(new Error('Cancelled cleanup'));
    return Promise.resolve({ object: { results: [] } } as Awaited<
      ReturnType<typeof cleanup.agent.generate>
    >);
  });
  await expect(cleanup.clean(sources, controller.signal)).rejects.toThrow(
    'Cancelled cleanup',
  );
});
