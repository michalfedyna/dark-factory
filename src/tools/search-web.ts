import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { CleanSearchResults } from '../contracts/web-search.js';
import { searchWeb } from '../integrations/web/search.js';

export function createSearchWebTool(clean: CleanSearchResults) {
  return createTool({
    id: 'search_web',
    description:
      'Search the public web through free, keyless DuckDuckGo HTML search. Uses an LLM to clean titles and snippets into plain text while preserving source URLs. Returns search results, not full pages or verified documentation. Prefer official library documentation and read relevant pages with web_fetch. Best effort: may be rate-limited or unavailable; cleanup failures return parsed results with an error. Never include secrets or private code in queries.',
    inputSchema: z.strictObject({
      query: z.string().trim().min(1).max(500),
      maxResults: z.number().int().min(1).max(10).default(5),
    }),
    outputSchema: z.strictObject({
      results: z.array(
        z.strictObject({
          title: z.string(),
          url: z.url({ protocol: /^https?$/ }),
          snippet: z.string(),
        }),
      ),
      error: z.string().nullable(),
    }),
    execute: async ({ query, maxResults }, context) => {
      const signal = context?.abortSignal;
      const response = await searchWeb(query, maxResults, signal);
      if (response.error || !response.results.length) return response;
      try {
        const results = await clean(response.results, signal);
        signal?.throwIfAborted();
        return { results, error: null };
      } catch {
        signal?.throwIfAborted();
        return {
          ...response,
          error:
            'Search cleanup unavailable; returning parsed results without LLM cleanup.',
        };
      }
    },
  });
}
