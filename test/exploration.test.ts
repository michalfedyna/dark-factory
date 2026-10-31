import { afterEach, describe, expect, test, vi } from 'vitest';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { runExploration } from '../src/factory/explore.js';
import { createExplorationWorkflow } from '../src/workflows/exploration.js';
import type { Explore } from '../src/agents/exploration.js';
import type { Ask } from '../src/contracts/interaction.js';
import { brief } from './fixtures/brief.js';

afterEach(() => {
  vi.useRealTimers();
});
const question = { question: 'Which format?', context: '', options: ['CSV'] };
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function setup(explore: Explore = () => Promise.resolve(brief)) {
  const save = vi.fn().mockResolvedValue('issue.json');
  const mastra = new Mastra({
    logger: false,
    workflows: { exploration: createExplorationWorkflow({ explore, save }) },
  });
  return {
    issue: 'Export issues',
    explore,
    ask: vi.fn<Ask>().mockResolvedValue(' CSV '),
    save,
    workflow: mastra.getWorkflow('exploration'),
    signal: new AbortController().signal,
    timeoutMs: 30_000,
  };
}

describe('Mastra exploration workflow', () => {
  test('executes typed steps and saves using the native workflow run ID', async () => {
    const options = setup();
    const run = await options.workflow.createRun();
    const result = await run.start({
      inputData: { issue: ' Export issues ' },
      requestContext: new RequestContext([
        ['ask', options.ask],
        ['signal', options.signal],
      ]),
    });
    expect(result.status).toBe('success');
    expect(result.steps['explore-issue']).toMatchObject({
      status: 'success',
      output: brief,
    });
    expect(result.steps['save-brief']).toMatchObject({
      status: 'success',
      output: { id: run.runId, brief, outputFile: 'issue.json' },
    });
    expect(options.save).toHaveBeenCalledExactlyOnceWith(run.runId, brief);
  });
  test('validates answers, resumes the agent, and saves the validated result', async () => {
    const options = setup(async (issue, ask, signal) => {
      expect(issue).toBe('Export issues');
      expect(await ask(question, signal)).toBe('CSV');
      return brief;
    });
    const result = await runExploration(options);
    expect(result.brief).toEqual(brief);
    expect(result.outputFile).toBe('issue.json');
    expect(options.save).toHaveBeenCalledWith(result.id, brief);
    expect(options.ask).toHaveBeenCalledWith(question, expect.any(AbortSignal));
  });
  test('fails closed on invalid model output or an empty answer', async () => {
    const invalid = setup(() => Promise.resolve({ title: 'Not a brief' }));
    await expect(runExploration(invalid)).rejects.toThrow('invalid brief');
    expect(invalid.save).not.toHaveBeenCalled();
    const empty = setup(async (_issue, ask, signal) => {
      await ask(question, signal);
      return brief;
    });
    empty.ask.mockResolvedValue(' ');
    await expect(runExploration(empty)).rejects.toThrow('Exploration failed');
    expect(empty.save).not.toHaveBeenCalled();
  });
  test('rejects empty issues before calling the agent', async () => {
    const options = setup(vi.fn());
    options.issue = ' ';
    await expect(runExploration(options)).rejects.toThrow();
    expect(options.explore).not.toHaveBeenCalled();
  });
  test('cancellation aborts pending work and never saves late results', async () => {
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
    const running = runExploration(options);
    await started.promise;
    controller.abort(new Error('Stopped by user.'));
    await expect(running).rejects.toThrow('Stopped by user.');
    expect(cancel).toHaveBeenCalledOnce();
    expect(run.abortController.signal.aborted).toBe(true);
    finish(brief);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(options.save).not.toHaveBeenCalled();
  });
  test('native cancellation aborts the agent and prevents the save step', async () => {
    const started = deferred<AbortSignal>();
    const finished = deferred<unknown>();
    const options = setup((_issue, _ask, signal) => {
      started.resolve(signal);
      return finished.promise;
    });
    const run = await options.workflow.createRun();
    const running = run.start({
      inputData: { issue: options.issue },
      requestContext: new RequestContext([
        ['ask', options.ask],
        ['signal', options.signal],
      ]),
    });
    const signal = await started.promise;
    await run.cancel();
    expect(signal.aborted).toBe(true);
    finished.resolve(brief);
    await running;
    expect(options.save).not.toHaveBeenCalled();
  });
  test('shared workflow definitions keep concurrent runs and answers separate', async () => {
    const options = setup(async (issue, ask, signal) => {
      expect(await ask({ ...question, question: issue }, signal)).toBe(issue);
      return brief;
    });
    const firstAsk = vi.fn<Ask>().mockResolvedValue('First issue');
    const secondAsk = vi.fn<Ask>().mockResolvedValue('Second issue');
    const results = await Promise.all([
      runExploration({ ...options, issue: 'First issue', ask: firstAsk }),
      runExploration({ ...options, issue: 'Second issue', ask: secondAsk }),
    ]);
    expect(results[0].id).not.toBe(results[1].id);
    expect(firstAsk).toHaveBeenCalledExactlyOnceWith(
      { ...question, question: 'First issue' },
      expect.any(AbortSignal),
    );
    expect(secondAsk).toHaveBeenCalledExactlyOnceWith(
      { ...question, question: 'Second issue' },
      expect.any(AbortSignal),
    );
    for (const result of results) {
      expect(options.save).toHaveBeenCalledWith(result.id, brief);
    }
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
    await runExploration(options);
    expect(promptSignal?.aborted).toBe(true);
  });
  test('times out even when an agent is not responding', async () => {
    vi.useFakeTimers();
    const options = setup(() => new Promise(() => {}));
    const running = expect(runExploration(options)).rejects.toThrow(
      'timed out',
    );
    await vi.advanceTimersByTimeAsync(30_001);
    await running;
    expect(options.save).not.toHaveBeenCalled();
  });
  test('does not expose provider secrets in errors', async () => {
    const options = setup(() =>
      Promise.reject(new Error('Authorization: Bearer secret-key')),
    );
    await expect(runExploration(options)).rejects.not.toThrow('secret-key');
  });
  test('reports output errors without exposing raw details', async () => {
    const options = setup();
    options.save.mockRejectedValue(new Error('sensitive/path'));
    await expect(runExploration(options)).rejects.toThrow('Check outputDir');
    expect(options.save).toHaveBeenCalledOnce();
  });
  test('never starts a pre-cancelled run', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Already stopped.'));
    const explore = vi.fn<Explore>();
    const options = { ...setup(explore), signal: controller.signal };
    const createRun = vi.spyOn(options.workflow, 'createRun');
    await expect(runExploration(options)).rejects.toThrow('Already stopped.');
    expect(explore).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });
});
