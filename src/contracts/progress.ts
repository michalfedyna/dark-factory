export type Activity =
  | { kind: 'stage'; message: string }
  | { kind: 'reasoning'; agent: string; id: string; text: string }
  | {
      kind: 'tool';
      agent: string;
      tool: string;
      status: 'started' | 'completed' | 'failed';
    }
  | { kind: 'check'; id: string; status: 'started' | 'passed' | 'failed' }
  | {
      kind: 'round';
      round: number;
      status: 'pending' | 'verifying' | 'repair' | 'approved' | 'blocked';
      blockingFindings: number;
      qa: string | null;
      review: string | null;
    };

export type Observe = (activity: Activity) => void;

interface ProgressSnapshot {
  stage: string;
  previousSummary: string;
  events: Activity[];
}

export type SummarizeProgress = (
  snapshot: ProgressSnapshot,
  signal: AbortSignal,
) => Promise<string>;
