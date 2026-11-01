import { afterEach, describe, expect, test, vi } from 'vitest';
import { createActivityHooks } from '../src/agents/activity.js';
import type { Observe, SummarizeProgress } from '../src/contracts/progress.js';
import { createProgressObserver } from '../src/factory/observer.js';

const observers: ReturnType<typeof createProgressObserver>[] = [];
afterEach(() => {
  for (const observer of observers.splice(0)) observer.close();
  vi.useRealTimers();
});

function setup(
  summarize = vi
    .fn<SummarizeProgress>()
    .mockResolvedValue('Inspecting the repository.'),
) {
  vi.useFakeTimers();
  const controller = new AbortController();
  const emit = vi.fn<(message: string) => void>();
  const observer = createProgressObserver({
    summarize,
    emit,
    intervalMs: 1_000,
    timeoutMs: 500,
    signal: controller.signal,
  });
  observers.push(observer);
  return { ...observer, summarize, emit, controller };
}

describe('background progress observer', () => {
  test('batches metadata, bounds context, and does not call the model on idle ticks', async () => {
    const observer = setup();
    observer.observe({ kind: 'stage', message: 'Inspecting repository' });
    for (let i = 0; i < 100; i++)
      observer.observe({ kind: 'check', id: `check-${i}`, status: 'passed' });
    await vi.advanceTimersByTimeAsync(999);
    expect(observer.summarize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(observer.summarize).toHaveBeenCalledOnce();
    const snapshot = observer.summarize.mock.calls[0]![0];
    expect(snapshot.stage).toBe('Inspecting repository');
    expect(snapshot.events).toHaveLength(40);
    expect(snapshot.events[0]).toEqual({
      kind: 'check',
      id: 'check-60',
      status: 'passed',
    });
    expect(observer.emit).toHaveBeenCalledExactlyOnceWith(
      'Inspecting the repository.',
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(observer.summarize).toHaveBeenCalledOnce();
  });

  test('passes the previous summary for continuity and suppresses duplicate updates', async () => {
    const observer = setup();
    observer.observe({ kind: 'stage', message: 'Inspecting repository' });
    await vi.advanceTimersByTimeAsync(1_000);
    observer.observe({ kind: 'check', id: 'lint', status: 'passed' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observer.summarize.mock.calls[1]![0].previousSummary).toBe(
      'Inspecting the repository.',
    );
    expect(observer.emit).toHaveBeenCalledOnce();
  });

  test('allows only one in-flight call and drops results from an older stage', async () => {
    let finish: (summary: string) => void = () => {};
    const summarize = vi
      .fn<SummarizeProgress>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue('Running checks.');
    const observer = setup(summarize);
    observer.observe({ kind: 'stage', message: 'Implementing' });
    await vi.advanceTimersByTimeAsync(1_000);
    observer.observe({ kind: 'stage', message: 'Running checks' });
    await vi.advanceTimersByTimeAsync(100);
    expect(summarize).toHaveBeenCalledOnce();
    finish('Still implementing.');
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900);
    expect(observer.emit).toHaveBeenCalledExactlyOnceWith('Running checks.');
  });

  test('pauses model calls and output during questions, even if the answer arrives before an old summary', async () => {
    let finish: (summary: string) => void = () => {};
    const summarize = vi
      .fn<SummarizeProgress>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue('Implementing the feature.');
    const observer = setup(summarize);
    observer.observe({ kind: 'stage', message: 'Implementing' });
    await vi.advanceTimersByTimeAsync(1_000);
    observer.pause();
    observer.observe({
      kind: 'tool',
      agent: 'exploration',
      tool: 'ask',
      status: 'started',
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(summarize).toHaveBeenCalledOnce();
    observer.resume();
    finish('An outdated update.');
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900);
    expect(observer.emit).toHaveBeenCalledExactlyOnceWith(
      'Implementing the feature.',
    );
    observer.pause();
    observer.observe({ kind: 'check', id: 'test', status: 'started' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  test('a provider/schema failure disables only summaries and never exposes the error', async () => {
    const observer = setup(
      vi
        .fn<SummarizeProgress>()
        .mockRejectedValue(new Error('Bearer secret-key')),
    );
    observer.observe({ kind: 'stage', message: 'Exploring' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observer.emit).toHaveBeenCalledExactlyOnceWith(
      'Progress summaries unavailable; continuing with stage updates.',
    );
    observer.observe({ kind: 'stage', message: 'Implementing' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(observer.summarize).toHaveBeenCalledOnce();
    expect(JSON.stringify(observer.emit.mock.calls)).not.toContain(
      'secret-key',
    );
  });

  test('gives model calls a timeout without waiting for them on close', async () => {
    let finish: (summary: string) => void = () => {};
    const observer = setup(
      vi.fn<SummarizeProgress>().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    observer.observe({ kind: 'stage', message: 'Exploring' });
    await vi.advanceTimersByTimeAsync(1_000);
    const signal = observer.summarize.mock.calls[0]![1];
    vi.useRealTimers();
    await vi.waitFor(
      () => {
        expect(signal.aborted).toBe(true);
      },
      { timeout: 2_000 },
    );
    observer.close();
    finish('Late update.');
    await Promise.resolve();
    expect(observer.emit).not.toHaveBeenCalled();
  });

  test.each(['close', 'abort'] as const)(
    '%s stops pending and in-flight work and suppresses late output',
    async (action) => {
      let finish: (summary: string) => void = () => {};
      const observer = setup(
        vi.fn<SummarizeProgress>().mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        ),
      );
      observer.observe({ kind: 'stage', message: 'Exploring' });
      await vi.advanceTimersByTimeAsync(1_000);
      if (action === 'close') observer.close();
      else observer.controller.abort();
      expect(observer.summarize.mock.calls[0]![1].aborted).toBe(true);
      finish('Late update.');
      observer.observe({ kind: 'stage', message: 'Implementing' });
      observer.resume();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(observer.summarize).toHaveBeenCalledOnce();
      expect(observer.emit).not.toHaveBeenCalled();
    },
  );

  test('a pre-cancelled observer never starts', async () => {
    const observer = setup();
    observer.controller.abort();
    observer.observe({ kind: 'stage', message: 'Exploring' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(observer.summarize).not.toHaveBeenCalled();
  });
});

test('native Mastra tool hooks forward metadata, not arguments, output, or errors', async () => {
  const observe = vi.fn<Observe>();
  const hooks = createActivityHooks('implementation', observe);
  const context = {
    toolName: 'read_file',
    input: { token: 'secret' },
    context: {},
  };
  await hooks.beforeToolCall?.(context);
  await hooks.afterToolCall?.({ ...context, output: 'private source' });
  await hooks.afterToolCall?.({
    ...context,
    error: new Error('Bearer secret-key'),
  });
  expect(observe.mock.calls.map(([event]) => event)).toEqual([
    {
      kind: 'tool',
      agent: 'implementation',
      tool: 'read_file',
      status: 'started',
    },
    {
      kind: 'tool',
      agent: 'implementation',
      tool: 'read_file',
      status: 'completed',
    },
    {
      kind: 'tool',
      agent: 'implementation',
      tool: 'read_file',
      status: 'failed',
    },
  ]);
});
