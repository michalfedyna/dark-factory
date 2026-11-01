import type { Activity } from './progress.js';

export type DebugEvent =
  | { kind: 'activity'; activity: Activity }
  | {
      kind: 'delta';
      agent: string;
      channel: 'text' | 'reasoning';
      id: string;
      text: string;
    }
  | { kind: 'detail'; agent: string; label: string; value: unknown };

/** Opt-in, potentially sensitive agent diagnostics; never sent to the Observer. */
export type Debug = (event: DebugEvent) => void;
