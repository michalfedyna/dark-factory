/** Diagnostic mirrors of native workflow execution, never recovery state. */
export interface StepEvent {
  step: string;
  status: 'started' | 'completed' | 'skipped' | 'failed' | 'cancelled';
  round: number;
  attempt: number;
  revision: string | null;
  deliveryStatus?: 'pending' | 'verifying' | 'repair' | 'approved' | 'blocked';
  timestamp: string;
  durationMs?: number;
  reason?: string;
}

export type RunOutcome = 'completed' | 'failed' | 'cancelled';

/** Abort active work because a prerequisite failed, not because the user cancelled. */
export class RunFailure extends Error {}
