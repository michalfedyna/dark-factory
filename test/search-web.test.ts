import { expect, test, vi } from 'vitest';
import { searchWeb } from '../src/integrations/web/search.js';
import { searchWebTool } from '../src/tools/search-web.js';

function result(title: string, href: string, snippet = '') {
  return `<div class="result results_links web-result"><h2><a class="result__a" href="${href}">${title}</a></h2><a class="result__snippet">${snippet}</a></div>`;
}

test('keyless search returns decoded, deduplicated links and compact snippets', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(
        result(
          'Library &amp; <b>guide</b>',
          '//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fguide%3Fa%3D1%26b%3D2&amp;rut=tracking',
          'Use <b>widgets</b> &#x27;carefully&#39; &lt;example&gt;',
        ) +
          result('Duplicate', 'https://docs.example.com/guide?a=1&amp;b=2') +
          result('Other', 'https://docs.example.com/other', 'x'.repeat(2_000)) +
          result('Overflow', 'https://docs.example.com/overflow'),
      ),
    );
  const controller = new AbortController();
  expect(
    await searchWeb('library + widgets & setup', 2, controller.signal),
  ).toEqual({
    results: [
      {
        title: 'Library & guide',
        url: 'https://docs.example.com/guide?a=1&b=2',
        snippet: "Use widgets 'carefully' <example>",
      },
      {
        title: 'Other',
        url: 'https://docs.example.com/other',
        snippet: 'x'.repeat(1_000),
      },
    ],
    error: null,
  });
  expect(fetch).toHaveBeenCalledOnce();
  const [input, options] = fetch.mock.calls[0]!;
  expect(input).toBeInstanceOf(URL);
  if (!(input instanceof URL)) throw new Error('Expected a URL request.');
  expect(input.href).toContain('https://html.duckduckgo.com/html/?q=');
  expect(input.searchParams.get('q')).toBe('library + widgets & setup');
  expect(options?.redirect).toBe('error');
  expect(options?.headers).toEqual({ Accept: 'text/html' });
  expect(options?.signal?.aborted).toBe(false);
});

test('ignores ads, invalid destinations, empty titles and search-engine links', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      '<div class="result result--ad"><a class="result__a" href="https://ads.example.com">Ad</a></div>' +
        [
          'javascript:alert(1)',
          'file:///etc/passwd',
          'https://name:password@docs.example.com',
          '//duckduckgo.com/l/?uddg=not-a-url',
          '//duckduckgo.com/l/',
          '/settings',
        ]
          .map((url) => result('Bad', url))
          .join('') +
        result('', 'https://empty.example.com') +
        result('Valid', 'https://docs.example.com'),
    ),
  );
  expect(await searchWeb('library', 5)).toEqual({
    results: [
      { title: 'Valid', url: 'https://docs.example.com/', snippet: '' },
    ],
    error: null,
  });
});

test('distinguishes genuine empty results from a challenge or markup change', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response('<div class="no-results">No results</div>'),
    )
    .mockResolvedValueOnce(
      new Response('<form id="challenge-form">Prove you are human</form>'),
    )
    .mockResolvedValueOnce(new Response('<html>Unexpected markup</html>'));
  expect(await searchWeb('nothing', 5)).toEqual({ results: [], error: null });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await searchWeb('library', 5);
    expect(response.results).toEqual([]);
    expect(response.error).toBeTypeOf('string');
  }
  expect(fetch).toHaveBeenCalledTimes(3);
});

test.each([202, 403, 429, 503])(
  'reports HTTP %s without retries',
  async (status) => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('unavailable', { status }));
    const response = await searchWeb('library', 5);
    expect(response.results).toEqual([]);
    expect(response.error).toContain(`HTTP ${status}`);
    expect(fetch).toHaveBeenCalledOnce();
  },
);

test('bounds response size and does not leak network errors', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('x'.repeat(1_000_001)))
    .mockRejectedValueOnce(new Error('secret network detail'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await searchWeb('library', 5);
    expect(response.results).toEqual([]);
    expect(response.error).toContain('unavailable');
    expect(response.error).not.toContain('secret network detail');
  }
});

test('propagates cancellation before requests and during fetch', async () => {
  const controller = new AbortController();
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation((_url, options) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      controller.abort(new Error('Cancelled'));
      return Promise.reject(new Error('fetch aborted'));
    });
  await expect(searchWeb('library', 5, controller.signal)).rejects.toThrow(
    'Cancelled',
  );
  await expect(searchWeb('library', 5, controller.signal)).rejects.toThrow(
    'Cancelled',
  );
  expect(fetch).toHaveBeenCalledOnce();
});

test('cancels an in-flight response body and preserves caller cancellation', async () => {
  const controller = new AbortController();
  let reading: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('<html>'));
        options?.signal?.addEventListener(
          'abort',
          () => stream.error(options.signal?.reason),
          { once: true },
        );
      },
      pull() {
        reading();
      },
    });
    return Promise.resolve(new Response(body));
  });
  const pending = searchWeb('library', 5, controller.signal);
  await started;
  controller.abort(new Error('Cancelled during response'));
  await expect(pending).rejects.toThrow('Cancelled during response');
});

test('reports request timeouts without swallowing caller cancellation', async () => {
  const controller = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(controller.signal);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(new Error('Request timed out')),
          { once: true },
        );
      }),
  );
  const pending = searchWeb('library', 5);
  controller.abort(new DOMException('Timed out', 'TimeoutError'));
  const response = await pending;
  expect(response.results).toEqual([]);
  expect(response.error).toContain('unavailable');
  expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000);
});

test('search_web validates input and uses five results by default', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(
        Array.from({ length: 7 }, (_, index) =>
          result(`Doc ${index}`, `https://docs.example.com/${index}`),
        ).join(''),
      ),
    );
  expect(searchWebTool.id).toBe('search_web');
  if (!searchWebTool.execute) throw new Error('Missing tool execution.');
  if (!searchWebTool.inputSchema) throw new Error('Missing tool schema.');
  const input = await searchWebTool.inputSchema['~standard'].validate({
    query: 'library',
  });
  if (input.issues) throw new Error('Expected valid search input.');
  const response = await searchWebTool.execute(input.value, {});
  expect(response).toHaveProperty('error', null);
  expect(response && 'results' in response && response.results).toHaveLength(5);
  for (const input of [
    { query: '' },
    { query: '  ' },
    { query: 'x'.repeat(501) },
    { query: 'library', maxResults: 0 },
    { query: 'library', maxResults: 11 },
  ]) {
    const invalid = await searchWebTool.execute(
      { maxResults: 5, ...input },
      {},
    );
    expect(invalid).toHaveProperty('error', true);
  }
  expect(fetch).toHaveBeenCalledOnce();
});
