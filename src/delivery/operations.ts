import type {
  DeliveryResult,
  DeliveryRound,
  DeliveryState,
} from '../contracts/delivery.js';
import type { IssueBrief } from '../contracts/issue.js';

// Agent results cross an untrusted boundary and are parsed by the workflow.
export interface DeliveryOperations {
  prepare: (brief: IssueBrief, signal: AbortSignal) => Promise<string>;
  implement: (state: DeliveryState, signal: AbortSignal) => Promise<unknown>;
  capture: (signal: AbortSignal) => Promise<{ revision: string; tree: string }>;
  checks: (round: DeliveryRound, signal: AbortSignal) => Promise<DeliveryRound>;
  qa: (state: DeliveryState, signal: AbortSignal) => Promise<unknown>;
  sandboxQa: (state: DeliveryState, signal: AbortSignal) => Promise<unknown>;
  validateQa: (
    state: DeliveryState,
    signal: AbortSignal,
    phase?: 'preliminary' | 'final',
  ) => Promise<DeliveryRound>;
  review: (state: DeliveryState, signal: AbortSignal) => Promise<unknown>;
  assertUnchanged: (revision: string, signal: AbortSignal) => Promise<void>;
  summarize: (state: DeliveryState, signal: AbortSignal) => Promise<unknown>;
  finish: (
    state: DeliveryState,
    signal: AbortSignal,
  ) => Promise<DeliveryResult>;
  record: (state: DeliveryState) => Promise<void>;
}
