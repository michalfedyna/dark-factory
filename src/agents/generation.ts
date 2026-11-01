import type { Agent } from '@mastra/core/agent';
import type { ChunkType } from '@mastra/core/stream';
import type { z } from 'zod';
import type { Debug } from '../contracts/debug.js';
import type { Observe } from '../contracts/progress.js';
import { createActivityHooks } from './activity.js';

function reportChunk(
  agent: string,
  chunk: ChunkType<unknown>,
  debug: Debug,
): void {
  const detail = (label: string, value: unknown) =>
    debug({ kind: 'detail', agent, label, value });
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      debug({
        kind: 'delta',
        agent,
        channel: chunk.type === 'text-delta' ? 'text' : 'reasoning',
        id: chunk.payload.id,
        text: chunk.payload.text,
      });
      break;
    case 'tool-call':
      detail(`Tool call · ${chunk.payload.toolName}`, {
        callId: chunk.payload.toolCallId,
        arguments: chunk.payload.args,
      });
      break;
    case 'tool-result':
      detail(
        `Tool ${chunk.payload.isError ? 'failed' : 'result'} · ${chunk.payload.toolName}`,
        { callId: chunk.payload.toolCallId, result: chunk.payload.result },
      );
      break;
    case 'tool-error':
      detail(`Tool failed · ${chunk.payload.toolName}`, {
        callId: chunk.payload.toolCallId,
        error: chunk.payload.error,
      });
      break;
    case 'step-start':
      detail('Step started', { model: chunk.payload.modelId });
      break;
    case 'step-finish':
    case 'finish':
      detail(chunk.type === 'finish' ? 'Usage' : 'Step finished', {
        reason: chunk.payload.stepResult.reason,
        usage: chunk.payload.output.usage,
      });
      break;
    case 'error':
      detail('Stream error', chunk.payload.error);
      break;
    case 'abort':
      detail('Cancelled', undefined);
      break;
    case 'source':
      detail('Source', {
        title: chunk.payload.title,
        url: chunk.payload.url,
        filename: chunk.payload.filename,
      });
      break;
    case 'file':
    case 'reasoning-file':
      detail('File', { mimeType: chunk.payload.mimeType });
      break;
    case 'tool-output':
      detail(
        `Tool output · ${chunk.payload.toolName ?? 'tool'}`,
        chunk.payload.output,
      );
      break;
  }
}

/** Use the same tools and strict result validation with or without diagnostics. */
export async function generateResult<T>(
  agent: Agent,
  schema: z.ZodType<T>,
  message: string,
  input: { signal: AbortSignal; observe?: Observe; debug?: Debug },
): Promise<T> {
  input.signal.throwIfAborted();
  const options = {
    abortSignal: input.signal,
    toolCallConcurrency: 1,
    hooks: createActivityHooks(agent.id, input.observe),
    structuredOutput: {
      schema,
      jsonPromptInjection: 'system' as const,
      errorStrategy: 'strict' as const,
    },
  };
  const debug: Debug | undefined = input.debug
    ? (event) => {
        if (!input.signal.aborted) input.debug?.(event);
      }
    : undefined;
  try {
    debug?.({
      kind: 'detail',
      agent: agent.id,
      label: 'Started',
      value: message,
    });
    const response = debug
      ? await (
          await agent.stream(message, {
            ...options,
            // Finish model output before opening an interactive ask prompt.
            eagerToolExecution: false,
            onChunk: (chunk) => reportChunk(agent.id, chunk, debug),
          })
        ).getFullOutput()
      : await agent.generate(message, options);
    input.signal.throwIfAborted();
    if (response.error) throw response.error;
    const result = schema.parse(response.object);
    debug?.({
      kind: 'detail',
      agent: agent.id,
      label: 'Completed',
      value: result,
    });
    return result;
  } catch (error) {
    debug?.({ kind: 'detail', agent: agent.id, label: 'Failed', value: error });
    throw error;
  }
}
