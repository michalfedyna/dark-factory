import type {
  Activity,
  Observe,
  SummarizeProgress,
} from '../contracts/progress.js';

export function createProgressObserver(options: {
  summarize: SummarizeProgress;
  emit: (message: string) => void;
  intervalMs: number;
  timeoutMs: number;
  signal: AbortSignal;
}) {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stage = '';
  let previousSummary = '';
  let events: Activity[] = [];
  let dirty = false;
  let busy = false;
  let paused = false;
  let disabled = false;
  let generation = 0;
  let nextRunAt = Date.now() + options.intervalMs;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (timer || busy || paused || disabled || signal.aborted || !dirty) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        void summarize();
      },
      Math.max(0, nextRunAt - Date.now()),
    );
    timer.unref();
  };
  const summarize = async () => {
    busy = true;
    dirty = false;
    nextRunAt = Date.now() + options.intervalMs;
    const currentGeneration = generation;
    const callSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(options.timeoutMs),
    ]);
    try {
      const summary = await options.summarize(
        { stage, previousSummary, events: [...events] },
        callSignal,
      );
      if (callSignal.aborted || paused || currentGeneration !== generation)
        return;
      const message = summary.replace(/\s+/g, ' ').trim().slice(0, 500);
      if (message && message !== previousSummary) {
        previousSummary = message;
        options.emit(message);
      }
    } catch {
      // This optional sidecar never fails the workflow or exposes provider errors.
      disabled = true;
      if (!signal.aborted && !paused)
        options.emit(
          'Progress summaries unavailable; continuing with stage updates.',
        );
    } finally {
      busy = false;
      schedule();
    }
  };
  const observe: Observe = (activity) => {
    if (signal.aborted || disabled) return;
    if (activity.kind === 'stage' && stage !== activity.message) {
      stage = activity.message;
      generation++;
    }
    // Keep a bounded metadata window rather than a growing conversation history.
    events = [...events.slice(-39), activity];
    dirty = true;
    schedule();
  };
  const close = () => {
    clearTimer();
    controller.abort();
    options.signal.removeEventListener('abort', close);
    events = [];
  };
  options.signal.addEventListener('abort', close, { once: true });
  if (options.signal.aborted) close();
  return {
    observe,
    pause: () => {
      paused = true;
      generation++;
      clearTimer();
    },
    resume: () => {
      paused = false;
      dirty = true;
      schedule();
    },
    close,
  };
}
