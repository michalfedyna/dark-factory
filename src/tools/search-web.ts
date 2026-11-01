import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { searchWeb } from '../integrations/web/search.js';

export const searchWebTool = createTool({
  id: 'search_web',
  description:
    'Search the public web through free, keyless DuckDuckGo HTML search. Returns titles, URLs and snippets, not full pages. Prefer official library documentation and read relevant pages with web_fetch. Best effort: may be rate-limited or unavailable. Never include secrets or private code in queries.',
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
  execute: ({ query, maxResults }, context) =>
    searchWeb(query, maxResults, context?.abortSignal),
});
