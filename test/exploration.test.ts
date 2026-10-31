import { afterEach, describe, expect, test, vi } from 'vitest';
import { runExploration } from '../src/factory/explore.js';
import type { Explore } from '../src/agents/exploration.js';
import type { Ask } from '../src/contracts/interaction.js';
import { brief } from './fixtures/brief.js';

afterEach(() => {
  vi.useRealTimers();
});
const question = { question: 'Which format?', context: '', options: ['CSV'] };
function setup(explore: Explore = () => Promise.resolve(brief)) {
  return {
    issue: 'Export issues',
    explore,
    ask: vi.fn<Ask>().mockResolvedValue(' CSV '),
    save: vi.fn().mockResolvedValue('issue.json'),
    signal: new AbortController().signal,
    timeoutMs: 30_000,
  };
}

describe('terminal exploration orchestration', () => {
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
    let finish: (value: unknown) => void = () => {};
    const options = setup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    options.signal = controller.signal;
    const running = runExploration(options);
    controller.abort(new Error('Stopped by user.'));
    await expect(running).rejects.toThrow('Stopped by user.');
    finish(brief);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(options.save).not.toHaveBeenCalled();
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
  });
  test('never starts a pre-cancelled run', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Already stopped.'));
    const explore = vi.fn<Explore>();
    const options = { ...setup(explore), signal: controller.signal };
    await expect(runExploration(options)).rejects.toThrow('Already stopped.');
    expect(explore).not.toHaveBeenCalled();
  });
});
