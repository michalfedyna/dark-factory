import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { writeObserver } from '../src/cli/observer.js';
import { createProgressSpinner } from '../src/cli/progress.js';
import { captureTerminalOutput } from './fixtures/terminal.js';

const spinners: ReturnType<typeof createProgressSpinner>[] = [];

function setup(isTTY = true) {
  const terminal = captureTerminalOutput(isTTY, 80);
  const progress = createProgressSpinner(terminal.output);
  spinners.push(progress);
  return { ...terminal, progress };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('CI', 'false');
});

afterEach(() => {
  spinners.splice(0).forEach((progress) => progress.close());
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('CLI progress spinner', () => {
  test('stage updates keep one animation timer and a steady frame rate', () => {
    const { progress, log } = setup();
    const listeners = process.listenerCount('SIGINT');

    progress.start('Exploring');
    vi.advanceTimersByTime(240);
    const initialFrames = log().match(/Exploring/g)?.length ?? 0;
    expect(initialFrames).toBeGreaterThan(0);

    progress.start('Preparing delivery');
    progress.start('Inspecting repository');
    progress.start('Inspecting repository');

    expect(vi.getTimerCount()).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(listeners + 1);
    vi.advanceTimersByTime(240);
    expect(log().match(/Inspecting repository/g)).toHaveLength(initialFrames);
    expect(log()).not.toContain('Preparing delivery');
  });

  test('clearing stops all redraws while a terminal question is visible', () => {
    const { progress, output, log } = setup();
    const listeners = process.listenerCount('SIGINT');
    progress.start('Exploring');
    progress.start('Inspecting repository');
    vi.advanceTimersByTime(240);

    progress.clear();
    output.write('Implement this brief?\n');
    const question = log();
    vi.advanceTimersByTime(1_000);

    expect(log()).toBe(question);
    expect(vi.getTimerCount()).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(listeners);

    progress.start('Inspecting repository');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(240);
    expect(log().slice(question.length)).toContain('Inspecting repository');
  });

  test('Observer updates can pause and resume without accumulating timers', () => {
    const { progress, output, log } = setup();
    progress.start('Exploring');
    progress.start('Inspecting repository');
    vi.advanceTimersByTime(240);

    for (let update = 0; update < 3; update++) {
      progress.clear();
      expect(vi.getTimerCount()).toBe(0);
      writeObserver('Reading repository files.', output);
      progress.start('Inspecting repository');
      vi.advanceTimersByTime(240);
      expect(vi.getTimerCount()).toBe(1);
    }

    expect(stripVTControlCharacters(log()).match(/Observer/g)).toHaveLength(3);
    progress.close();
    const finalOutput = log();
    vi.advanceTimersByTime(1_000);
    expect(log()).toBe(finalOutput);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('closing is idempotent and prevents late updates from restarting it', () => {
    const { progress, log } = setup();
    const listeners = process.listenerCount('SIGINT');
    progress.start('Exploring');
    vi.advanceTimersByTime(240);

    progress.close();
    const finalOutput = log();
    progress.close();
    progress.clear();
    progress.start('Inspecting repository');
    vi.advanceTimersByTime(1_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(listeners);
    expect(log()).toBe(finalOutput);
  });

  test('redirected output never starts an animation or emits escape codes', () => {
    const { progress, log } = setup(false);
    progress.start('Exploring');
    progress.start('Inspecting repository');
    progress.clear();
    progress.start('Inspecting repository');
    progress.close();
    vi.advanceTimersByTime(1_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(log()).toBe('');
  });
});
