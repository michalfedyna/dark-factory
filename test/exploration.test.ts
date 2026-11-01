import { describe, expect, test, vi } from 'vitest';
import { runDefault } from '../src/factory/run.js';
import type { Explore } from '../src/agents/exploration.js';
import type { Ask } from '../src/contracts/interaction.js';
import { brief } from './fixtures/brief.js';
import { createWorkflowSetup } from './fixtures/workflow.js';

const question = { question: 'Which format?', context: '', options: ['CSV'] };
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function setup(explore: Explore = () => Promise.resolve(brief)) {
  return createWorkflowSetup(explore);
}

describe('default workflow exploration stages', () => {
  test('validates answers and passes the brief directly to preparation in the same run', async () => {
    const options = setup(async (issue, ask, signal) => {
      expect(issue).toBe('Export issues');
      expect(await ask(question, signal)).toBe('CSV');
      return brief;
    });
    const createRun = vi.spyOn(options.workflow, 'createRun');
    const result = await runDefault(options);
    expect(createRun).toHaveBeenCalledOnce();
    expect(options.operations.prepare).toHaveBeenCalledWith(
      brief,
      expect.any(AbortSignal),
    );
    expect(options.runtime).toHaveBeenCalledWith(
      result.runId,
      expect.any(AbortSignal),
    );
    expect(options.ask).toHaveBeenCalledWith(question, expect.any(AbortSignal));
  });
  test('starts delivery observation only after exploration validates and before delivery progress', async () => {
    const finished = deferred<unknown>();
    const started = deferred<void>();
    const options = setup(async (_issue, ask, signal) => {
      await ask(question, signal);
      started.resolve();
      return finished.promise;
    });
    const running = runDefault(options);
    await started.promise;
    expect(options.onDeliveryStart).not.toHaveBeenCalled();
    options.onDeliveryStart.mockImplementation((signal) => {
      expect(signal.aborted).toBe(false);
      expect(options.progress).toHaveBeenCalledExactlyOnceWith('Exploring');
      expect(options.operations.prepare).not.toHaveBeenCalled();
    });
    finished.resolve(brief);
    await running;
    expect(options.onDeliveryStart).toHaveBeenCalledExactlyOnceWith(
      options.runtime.mock.calls[0]?.[1],
    );
  });
  test('does not start delivery observation for an unconfirmed brief', async () => {
    const options = setup(() =>
      Promise.resolve({
        ...brief,
        readiness: 'needs-clarification',
        confirmedByUser: false,
      }),
    );
    await expect(runDefault(options)).rejects.toThrow('Workflow failed');
    expect(options.onDeliveryStart).not.toHaveBeenCalled();
  });
  test('fails closed on invalid model output or an empty answer', async () => {
    const invalid = setup(() => Promise.resolve({ title: 'Not a brief' }));
    await expect(runDefault(invalid)).rejects.toThrow('invalid brief');
    expect(invalid.operations.prepare).not.toHaveBeenCalled();
    expect(invalid.onDeliveryStart).not.toHaveBeenCalled();
    const empty = setup(async (_issue, ask, signal) => {
      await ask(question, signal);
      return brief;
    });
    empty.ask.mockResolvedValue(' ');
    await expect(runDefault(empty)).rejects.toThrow('Exploration failed');
    expect(empty.operations.prepare).not.toHaveBeenCalled();
    expect(empty.onDeliveryStart).not.toHaveBeenCalled();
  });
  test('rejects empty issues before calling the agent', async () => {
    const options = setup(vi.fn());
    options.issue = ' ';
    await expect(runDefault(options)).rejects.toThrow();
    expect(options.explore).not.toHaveBeenCalled();
  });
  test('cancellation aborts pending work and never prepares late results', async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    let finish: (value: unknown) => void = () => {};
    const options = setup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          started.resolve();
        }),
    );
    const run = await options.workflow.createRun();
    const cancel = vi.spyOn(run, 'cancel');
    vi.spyOn(options.workflow, 'createRun').mockResolvedValueOnce(run);
    options.signal = controller.signal;
    const running = runDefault(options);
    await started.promise;
    controller.abort(new Error('Stopped by user.'));
    await expect(running).rejects.toThrow('Stopped by user.');
    expect(cancel).toHaveBeenCalledOnce();
    expect(run.abortController.signal.aborted).toBe(true);
    finish(brief);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(options.operations.prepare).not.toHaveBeenCalled();
    expect(options.onDeliveryStart).not.toHaveBeenCalled();
  });
  test('native cancellation aborts the agent and prevents preparation', async () => {
    const started = deferred<AbortSignal>();
    const finished = deferred<unknown>();
    const options = setup((_issue, _ask, signal) => {
      started.resolve(signal);
      return finished.promise;
    });
    const run = await options.workflow.createRun();
    const running = run.start({
      inputData: { issue: options.issue },
      requestContext: options.requestContext(run.runId),
    });
    const signal = await started.promise;
    await run.cancel();
    expect(signal.aborted).toBe(true);
    finished.resolve(brief);
    await running;
    expect(options.operations.prepare).not.toHaveBeenCalled();
    expect(options.onDeliveryStart).not.toHaveBeenCalled();
  });
  test('shared workflow definitions keep concurrent runs and answers separate', async () => {
    const options = setup(async (issue, ask, signal) => {
      expect(await ask({ ...question, question: issue }, signal)).toBe(issue);
      return brief;
    });
    const firstAsk = vi.fn<Ask>().mockResolvedValue('First issue');
    const secondAsk = vi.fn<Ask>().mockResolvedValue('Second issue');
    const results = await Promise.all([
      runDefault({ ...options, issue: 'First issue', ask: firstAsk }),
      runDefault({ ...options, issue: 'Second issue', ask: secondAsk }),
    ]);
    expect(results[0].runId).not.toBe(results[1].runId);
    expect(firstAsk).toHaveBeenCalledExactlyOnceWith(
      { ...question, question: 'First issue' },
      expect.any(AbortSignal),
    );
    expect(secondAsk).toHaveBeenCalledExactlyOnceWith(
      { ...question, question: 'Second issue' },
      expect.any(AbortSignal),
    );
    expect(options.operations.prepare).toHaveBeenCalledTimes(2);
  });
  test('rejects concurrent questions and closes pending input when the run ends', async () => {
    let promptSignal: AbortSignal | undefined;
    const options = setup(async (_issue, ask, signal) => {
      const pending = ask(question, signal);
      await expect(ask(question, signal)).rejects.toThrow(
        'Ask one question at a time',
      );
      void pending.catch(() => {});
      return brief;
    });
    options.ask.mockImplementation((_question, signal) => {
      promptSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('Prompt closed.'));
        });
      });
    });
    await runDefault(options);
    expect(promptSignal?.aborted).toBe(true);
  });
  test('times out even when an agent is not responding', async () => {
    vi.useFakeTimers();
    const options = setup(() => new Promise(() => {}));
    const running = expect(runDefault(options)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_001);
    await running;
    expect(options.operations.prepare).not.toHaveBeenCalled();
    expect(options.onDeliveryStart).not.toHaveBeenCalled();
  });
  test('does not expose provider secrets in errors', async () => {
    const options = setup(() =>
      Promise.reject(new Error('Authorization: Bearer secret-key')),
    );
    await expect(runDefault(options)).rejects.not.toThrow('secret-key');
  });
  test('never starts a pre-cancelled run', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Already stopped.'));
    const explore = vi.fn<Explore>();
    const options = { ...setup(explore), signal: controller.signal };
    const createRun = vi.spyOn(options.workflow, 'createRun');
    await expect(runDefault(options)).rejects.toThrow('Already stopped.');
    expect(explore).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });
});
