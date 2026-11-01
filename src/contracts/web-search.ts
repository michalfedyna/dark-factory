export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type CleanSearchResults = (
  results: SearchResult[],
  signal?: AbortSignal,
) => Promise<SearchResult[]>;
