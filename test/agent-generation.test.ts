import type { Agent } from '@mastra/core/agent';
import { ChunkFrom, type ChunkType } from '@mastra/core/stream';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { generateResult } from '../src/agents/generation.js';
import type { Debug } from '../src/contracts/debug.js';
import type { Observe } from '../src/contracts/progress.js';

function setup() {
  const generate = vi.fn().mockResolvedValue({ object: { summary: 'Done' } });
  const getFullOutput = vi
    .fn()
    .mockResolvedValue({ object: { summary: 'Done' } });
  let onChunk: (chunk: ChunkType<unknown>) => void = () => {};
  const stream = vi
    .fn()
    .mockImplementation(
      (_message: string, options: { onChunk: typeof onChunk }) => {
        onChunk = options.onChunk;
        return Promise.resolve({ getFullOutput });
      },
    );
  const agent = { id: 'implementation', generate, stream } as unknown as Agent;
  const controller = new AbortController();
  const debug = vi.fn<Debug>();
  const observe = vi.fn<Observe>();
  const schema = z.strictObject({ summary: z.string() });
  const emit = (chunk: ChunkType<unknown>) => onChunk(chunk);
  return {
    agent,
    generate,
    stream,
    getFullOutput,
    controller,
    debug,
    observe,
    schema,
    emit,
  };
}

test('keeps normal generation non-streaming and validates its result', async () => {
  const s = setup();
  expect(
    await generateResult(s.agent, s.schema, 'task', {
      signal: s.controller.signal,
    }),
  ).toEqual({ summary: 'Done' });
  expect(s.generate).toHaveBeenCalledExactlyOnceWith(
    'task',
    expect.objectContaining({
      abortSignal: s.controller.signal,
      toolCallConcurrency: 1,
      structuredOutput: {
        schema: s.schema,
        jsonPromptInjection: 'system',
        errorStrategy: 'strict',
      },
    }),
  );
  expect(s.stream).not.toHaveBeenCalled();
});

test('streams native chunks before completion without forwarding provider metadata', async () => {
  const s = setup();
  let finish: (value: unknown) => void = () => {};
  s.getFullOutput.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const running = generateResult(s.agent, s.schema, 'task', {
    signal: s.controller.signal,
    debug: s.debug,
  });
  await vi.waitFor(() => expect(s.getFullOutput).toHaveBeenCalledOnce());
  const base = { runId: 'run', from: ChunkFrom.AGENT };
  s.emit({
    ...base,
    type: 'reasoning-delta',
    payload: {
      id: 'r1',
      text: 'Checking',
      providerMetadata: { openai: { encrypted_content: 'encrypted-private' } },
    },
  });
  s.emit({
    ...base,
    type: 'text-delta',
    payload: { id: 't1', text: 'Working' },
  });
  const args: Record<string, unknown> = { path: 'file.ts' };
  s.emit({
    ...base,
    type: 'tool-call',
    payload: { toolName: 'read_file', toolCallId: 'call', args },
  });
  s.emit({
    ...base,
    type: 'tool-result',
    payload: {
      toolName: 'read_file',
      toolCallId: 'call',
      result: 'source code',
    },
  });
  expect(s.debug).toHaveBeenCalledWith({
    kind: 'delta',
    agent: 'implementation',
    channel: 'reasoning',
    id: 'r1',
    text: 'Checking',
  });
  expect(s.debug).toHaveBeenCalledWith({
    kind: 'detail',
    agent: 'implementation',
    label: 'Tool result · read_file',
    value: { callId: 'call', result: 'source code' },
  });
  expect(JSON.stringify(s.debug.mock.calls)).not.toContain('encrypted-private');
  expect(
    s.debug.mock.calls.some(
      ([event]) => event.kind === 'detail' && event.label === 'Completed',
    ),
  ).toBe(false);
  finish({ object: { summary: 'Done' } });
  expect(await running).toEqual({ summary: 'Done' });
  expect(s.generate).not.toHaveBeenCalled();
  expect(s.stream).toHaveBeenCalledWith(
    'task',
    expect.objectContaining({
      eagerToolExecution: false,
      abortSignal: s.controller.signal,
    }),
  );
});

test.each([
  ['debug', 'invalid'],
  ['debug', 'provider-error'],
  ['debug', 'throw'],
  ['observe', 'invalid'],
  ['observe', 'provider-error'],
  ['observe', 'throw'],
] as const)(
  '%s does not weaken validation or swallow failures (%s)',
  async (sink, mode) => {
    const s = setup();
    if (mode === 'invalid')
      s.getFullOutput.mockResolvedValue({ object: { wrong: 'value' } });
    else if (mode === 'provider-error')
      s.getFullOutput.mockResolvedValue({
        error: new Error('Provider failed'),
      });
    else s.stream.mockRejectedValue(new Error('Stream failed'));
    await expect(
      generateResult(s.agent, s.schema, 'task', {
        signal: s.controller.signal,
        [sink]: s[sink],
      }),
    ).rejects.toThrow();
    if (sink === 'debug')
      expect(s.debug).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'detail', label: 'Failed' }),
      );
    else expect(s.observe).not.toHaveBeenCalled();
  },
);

test('cancellation suppresses late stream diagnostics and results', async () => {
  const s = setup();
  s.getFullOutput.mockImplementation(() => {
    s.controller.abort(new Error('Cancelled'));
    s.emit({
      runId: 'run',
      from: ChunkFrom.AGENT,
      type: 'text-delta',
      payload: { id: 'text', text: 'Late' },
    });
    s.emit({
      runId: 'run',
      from: ChunkFrom.AGENT,
      type: 'reasoning-delta',
      payload: { id: 'reasoning', text: 'Late thinking' },
    });
    return Promise.resolve({ object: { summary: 'Done' } });
  });
  await expect(
    generateResult(s.agent, s.schema, 'task', {
      signal: s.controller.signal,
      debug: s.debug,
      observe: s.observe,
    }),
  ).rejects.toThrow('Cancelled');
  expect(s.debug).toHaveBeenCalledTimes(1);
  expect(s.observe).not.toHaveBeenCalled();
});

test.each([false, true])(
  'streams reasoning to observation before completion, with no other content (debug: %s)',
  async (debug) => {
    const s = setup();
    let finish: (value: unknown) => void = () => {};
    s.getFullOutput.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = generateResult(s.agent, s.schema, 'private task', {
      signal: s.controller.signal,
      observe: s.observe,
      ...(debug ? { debug: s.debug } : {}),
    });
    await vi.waitFor(() => expect(s.getFullOutput).toHaveBeenCalledOnce());
    const base = { runId: 'run', from: ChunkFrom.AGENT };
    s.emit({
      ...base,
      type: 'reasoning-delta',
      payload: {
        id: 'r1',
        text: 'Checking the validation path.',
        providerMetadata: {
          openai: { encrypted_content: 'encrypted-private' },
        },
      },
    });
    s.emit({
      ...base,
      type: 'text-delta',
      payload: { id: 't1', text: 'private response' },
    });
    const args: Record<string, unknown> = { path: 'private.ts' };
    s.emit({
      ...base,
      type: 'tool-call',
      payload: { toolName: 'read_file', toolCallId: 'call', args },
    });
    s.emit({
      ...base,
      type: 'tool-result',
      payload: {
        toolName: 'read_file',
        toolCallId: 'call',
        result: 'private source',
      },
    });
    expect(s.observe).toHaveBeenCalledExactlyOnceWith({
      kind: 'reasoning',
      agent: 'implementation',
      id: 'r1',
      text: 'Checking the validation path.',
    });
    expect(s.generate).not.toHaveBeenCalled();
    if (!debug) expect(s.debug).not.toHaveBeenCalled();
    finish({ object: { summary: 'Done' } });
    expect(await running).toEqual({ summary: 'Done' });
  },
);
