import { stripVTControlCharacters } from 'node:util';
import { afterEach, expect, test, vi } from 'vitest';
import { createDebugWriter } from '../src/cli/debug.js';
import type { DebugEvent } from '../src/contracts/debug.js';
import { captureTerminalOutput } from './fixtures/terminal.js';

afterEach(() => vi.unstubAllEnvs());

const text = (value: string, id = 'message'): DebugEvent => ({
  kind: 'delta',
  agent: 'implementation',
  channel: 'text',
  id,
  text: value,
});

test('writes tokens immediately under one heading and closes partial lines before details', () => {
  const { output, log } = captureTerminalOutput(false);
  const debug = createDebugWriter(output);
  debug.write(text('Reading '));
  expect(log()).toBe('\nimplementation · Text\nReading ');
  debug.write(text('files.'));
  debug.write({
    kind: 'detail',
    agent: 'implementation',
    label: 'Completed',
    value: { summary: 'Done' },
  });
  debug.close();
  expect(log()).toBe(
    '\nimplementation · Text\nReading files.\n\nimplementation · Completed\n{\n  "summary": "Done"\n}\n',
  );
});

test.each([true, false])(
  'formats details and strips untrusted terminal controls (TTY: %s)',
  (tty) => {
    vi.stubEnv('FORCE_COLOR', '1');
    const { output, log } = captureTerminalOutput(tty, 32);
    const debug = createDebugWriter(output);
    debug.write({
      kind: 'detail',
      agent: 'qa',
      label: 'Tool result',
      value: '\u001b[2Jhello\r\b\u0007\nworld',
    });
    debug.write(text('\u001b['));
    debug.write(text('2Jhello\u0007'));
    debug.close();
    expect(log()).not.toContain('\u001b[2J');
    expect(log()).not.toContain('\r');
    expect(log()).not.toContain('\b');
    expect(log()).not.toContain('\u0007');
    expect(stripVTControlCharacters(log())).toContain('qa · Tool result');
    if (!tty) expect(log()).not.toContain('\u001b');
  },
);

test('uses terminal-width accent blocks and respects NO_COLOR', () => {
  vi.stubEnv('FORCE_COLOR', undefined);
  vi.stubEnv('NO_COLOR', '1');
  const { output, log } = captureTerminalOutput(true, 24);
  const debug = createDebugWriter(output);
  debug.write({
    kind: 'detail',
    agent: 'review',
    label: 'Result',
    value: 'a'.repeat(32),
  });
  debug.write(text('hello'));
  debug.close();
  expect(log()).not.toContain('\u001b');
  expect(log()).toContain('│  review · Result');
  expect(log()).toContain(`│  ${'a'.repeat(20)}\n│  ${'a'.repeat(12)}`);
});

test('redacts credentials in structured output and across token boundaries without hiding usage', () => {
  const { output, log } = captureTerminalOutput(false);
  const debug = createDebugWriter(output, ['test-key']);
  debug.write(text('Authorization: Bearer test-'));
  expect(log()).not.toContain('test-');
  debug.write(text('key; done.'));
  debug.write({
    kind: 'detail',
    agent: 'review',
    label: 'Result',
    value: {
      apiKey: 'another-key',
      authorization: 'Bearer another-key',
      access_token: 'private',
      usage: { inputTokens: 10, outputTokens: 20 },
      nested: { password: 'private' },
      message: 'test-key',
    },
  });
  debug.close();
  expect(log()).not.toContain('test-key');
  expect(log()).not.toContain('another-key');
  expect(log()).not.toContain('private');
  expect(log()).toContain('Bearer [redacted]; done.');
  expect(log()).toContain('"inputTokens": 10');
  expect(log()).toContain('"outputTokens": 20');
});

test('buffers diagnostics during prompts and ignores updates after close', () => {
  const { output, log } = captureTerminalOutput(false);
  const debug = createDebugWriter(output);
  debug.write(text('Before'));
  debug.pause();
  const before = log();
  debug.write(text('During'));
  expect(log()).toBe(before);
  output.write('Question answered\n');
  debug.resume();
  expect(log()).toContain(
    'Before\nQuestion answered\n\nimplementation · Text\nDuring',
  );
  debug.close();
  const closed = log();
  debug.write(text('Late'));
  debug.resume();
  debug.close();
  expect(log()).toBe(closed);
});

test('renders failures, check outcomes, and repair gates without dumping binary or circular data', () => {
  const { output, log } = captureTerminalOutput(false);
  const debug = createDebugWriter(output, ['test-key']);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  debug.write({
    kind: 'detail',
    agent: 'qa',
    label: 'Failed',
    value: new Error('Bearer test-key'),
  });
  debug.write({
    kind: 'detail',
    agent: 'qa',
    label: 'Capture',
    value: {
      bytes: new Uint8Array(3),
      base64: 'a'.repeat(300),
      image: 'small-image-data',
      counter: 1n,
      circular,
    },
  });
  debug.write({
    kind: 'activity',
    activity: { kind: 'check', id: 'lint', status: 'passed' },
  });
  debug.write({
    kind: 'activity',
    activity: {
      kind: 'round',
      round: 1,
      status: 'repair',
      blockingFindings: 1,
      qa: 'fail',
      review: null,
    },
  });
  debug.close();
  expect(log()).toContain('Bearer [redacted]');
  expect(log()).toContain('[binary: 3 bytes]');
  expect(log()).toContain('[binary data omitted]');
  expect(log()).toContain('[circular]');
  expect(log()).toContain('Check · lint · passed');
  expect(log()).toContain('Round 1 · repair');
  expect(log()).not.toContain('a'.repeat(300));
  expect(log()).not.toContain('small-image-data');
});
