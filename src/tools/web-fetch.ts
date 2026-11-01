import {
  webFetchTool as mastraWebFetchTool,
  type Tool,
} from '@mastra/core/tools';

// Mastra 1.81's built-in declaration uses an unresolved import("..") under NodeNext.
// Preserve the built-in implementation and expose its documented public types.
export const webFetchTool = mastraWebFetchTool as unknown as Tool<
  { url: string },
  {
    content: string;
    truncated?: boolean;
    status?: number;
    statusText?: string;
    contentType?: string | null;
    url?: string;
    ok?: boolean;
    isError?: boolean;
  }
>;
