import { DomUtils, parseDocument } from 'htmlparser2';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import type { SearchResult } from '../../contracts/web-search.js';

const searchEndpoint = 'https://html.duckduckgo.com/html/';
const maxResponseBytes = 1_000_000;

function hasClass(element: { attribs: Record<string, string> }, name: string) {
  return element.attribs.class?.split(/\s+/).includes(name) ?? false;
}

function resultUrl(href: string): string | null {
  try {
    let url = new URL(href, searchEndpoint);
    if (
      ['duckduckgo.com', 'html.duckduckgo.com'].includes(url.hostname) &&
      url.pathname === '/l/'
    ) {
      const destination = url.searchParams.get('uddg');
      if (!destination) return null;
      url = new URL(destination);
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      ['duckduckgo.com', 'html.duckduckgo.com'].includes(url.hostname)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function parseResults(html: string, maxResults: number): SearchResult[] {
  const document = parseDocument(html);
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const result of DomUtils.findAll(
    (element) => hasClass(element, 'result'),
    document.children,
  )) {
    if (hasClass(result, 'result--ad')) continue;
    const link = DomUtils.findOne(
      (element) => element.name === 'a' && hasClass(element, 'result__a'),
      result.children,
    );
    const url = link?.attribs.href ? resultUrl(link.attribs.href) : null;
    const title = link
      ? DomUtils.innerText(link).replace(/\s+/g, ' ').trim().slice(0, 240)
      : '';
    if (!url || !title || seen.has(url)) continue;
    const snippet = DomUtils.findOne(
      (element) => hasClass(element, 'result__snippet'),
      result.children,
    );
    results.push({
      title,
      url,
      snippet: snippet
        ? DomUtils.innerText(snippet)
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 1_000)
        : '',
    });
    seen.add(url);
    if (results.length === maxResults) break;
  }
  if (
    !results.length &&
    !DomUtils.findOne(
      (element) => hasClass(element, 'no-results'),
      document.children,
    )
  )
    throw new Error('Search returned a challenge or an unsupported page.');
  return results;
}

async function readHtml(response: Response): Promise<string> {
  if (!response.body) throw new Error('Search returned an empty response.');
  const reader =
    response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return html + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxResponseBytes)
        throw new Error('Search response exceeded its size limit.');
      html += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

/** Keyless, best-effort search. Never follow result URLs or bypass challenges. */
export async function searchWeb(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<{ results: SearchResult[]; error: string | null }> {
  signal?.throwIfAborted();
  const url = new URL(searchEndpoint);
  url.searchParams.set('q', query);
  const requestSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(15_000),
  ]);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'text/html' },
      redirect: 'error',
      signal: requestSignal,
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return {
        results: [],
        error: `Web search unavailable (HTTP ${response.status}); do not retry challenges or rate limits repeatedly.`,
      };
    }
    const html = await readHtml(response);
    signal?.throwIfAborted();
    return { results: parseResults(html, maxResults), error: null };
  } catch {
    signal?.throwIfAborted();
    return {
      results: [],
      error:
        'Web search unavailable: network failure, timeout, challenge, or unsupported response. Try a known official documentation URL with web_fetch; do not claim the search succeeded.',
    };
  }
}
