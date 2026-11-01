import type { Agent } from '@mastra/core/agent';
import { ChunkFrom, type ChunkType } from '@mastra/core/stream';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { generateResult } from '../src/agents/generation.js';
import type { Debug } from '../src/contracts/debug.js';

function setup() {
  const generate = vi.fn().mockResolvedValue({ object: { summary: 'Done' } });
  const getFullOutput = vi
    .fn()
    .mockResolvedValue({ object: { summary: 'Done' } });
  const stream = vi.fn().mockResolvedValue({ getFullOutput });
  const agent = { id: 'implementation', generate, stream } as unknown as Agent;
  const controller = new AbortController();
  const debug = vi.fn<Debug>();
  const schema = z.strictObject({ summary: z.string() });
  return { agent, generate, stream, getFullOutput, controller, debug, schema };
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
  let onChunk: (chunk: ChunkType<unknown>) => void = () => {};
  s.stream.mockImplementation(
    (_message: string, options: { onChunk: typeof onChunk }) => {
      onChunk = options.onChunk;
      return Promise.resolve({ getFullOutput: s.getFullOutput });
    },
  );
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
  onChunk({
    ...base,
    type: 'reasoning-delta',
    payload: {
      id: 'r1',
      text: 'Checking',
      providerMetadata: { openai: { encrypted_content: 'encrypted-private' } },
    },
  });
  onChunk({
    ...base,
    type: 'text-delta',
    payload: { id: 't1', text: 'Working' },
  });
  const args: Record<string, unknown> = { path: 'file.ts' };
  onChunk({
    ...base,
    type: 'tool-call',
    payload: { toolName: 'read_file', toolCallId: 'call', args },
  });
  onChunk({
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

test.each(['invalid', 'provider-error', 'throw'])(
  'debug does not weaken validation or swallow failures (%s)',
  async (mode) => {
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
        debug: s.debug,
      }),
    ).rejects.toThrow();
    expect(s.debug).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'detail', label: 'Failed' }),
    );
  },
);

test('cancellation suppresses late stream diagnostics and results', async () => {
  const s = setup();
  s.getFullOutput.mockImplementation(() => {
    s.controller.abort(new Error('Cancelled'));
    const options = s.stream.mock.calls[0]?.[1] as {
      onChunk: (chunk: ChunkType<unknown>) => void;
    };
    options.onChunk({
      runId: 'run',
      from: ChunkFrom.AGENT,
      type: 'text-delta',
      payload: { id: 'text', text: 'Late' },
    });
    return Promise.resolve({ object: { summary: 'Done' } });
  });
  await expect(
    generateResult(s.agent, s.schema, 'task', {
      signal: s.controller.signal,
      debug: s.debug,
    }),
  ).rejects.toThrow('Cancelled');
  expect(s.debug).toHaveBeenCalledTimes(1);
});
