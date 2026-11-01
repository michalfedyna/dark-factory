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
  secrets?: string[];
  signal: AbortSignal;
}) {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stage = '';
  let previousSummary = '';
  let events: { sequence: number; activity: Activity }[] = [];
  let sequence = 0;
  let snapshotSequence = 0;
  let busy = false;
  let paused = false;
  let disabled = false;
  let generation = 0;
  let nextRunAt = Date.now() + options.intervalMs;
  const credentials = options.secrets?.filter(Boolean) ?? [];
  const redact = (text: string) => {
    for (const secret of credentials) {
      text = text.replaceAll(secret, '[redacted]');
      // A snapshot can end between credential chunks. Do not send its prefix.
      for (
        let length = Math.min(secret.length - 1, text.length);
        length > 0;
        length--
      )
        if (text.endsWith(secret.slice(0, length))) {
          text = `${text.slice(0, -length)}[redacted]`;
          break;
        }
    }
    return text;
  };

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (timer || busy || paused || disabled || signal.aborted || !events.length)
      return;
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
    nextRunAt = Date.now() + options.intervalMs;
    const currentGeneration = generation;
    const currentSequence = sequence;
    snapshotSequence = currentSequence;
    const callSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(options.timeoutMs),
    ]);
    try {
      const summary = await options.summarize(
        {
          stage,
          previousSummary,
          events: events.map(({ activity }) =>
            activity.kind === 'reasoning'
              ? { ...activity, text: redact(activity.text) }
              : activity,
          ),
        },
        callSignal,
      );
      if (callSignal.aborted || paused || currentGeneration !== generation)
        return;
      // Consume this batch, including silent updates, but retain newer activity.
      events = events.filter((event) => event.sequence > currentSequence);
      const message = redact(summary).replace(/\s+/g, ' ').trim().slice(0, 500);
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
    if (activity.kind === 'reasoning') {
      if (!activity.text) return;
      const previous = events.at(-1);
      // Never merge into a batch already being summarized: its text is consumed.
      if (
        previous &&
        previous.sequence > snapshotSequence &&
        previous.activity.kind === 'reasoning' &&
        previous.activity.agent === activity.agent &&
        previous.activity.id === activity.id
      ) {
        activity = {
          ...activity,
          text: previous.activity.text + activity.text,
        };
        events = events.slice(0, -1);
      }
      activity = { ...activity, text: activity.text.slice(-2_000) };
    }
    // Bound unprocessed activity, coalescing tokens instead of evicting metadata.
    events = [...events.slice(-39), { sequence: ++sequence, activity }];
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
      schedule();
    },
    close,
  };
}
