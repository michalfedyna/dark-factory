import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalSandbox } from '@mastra/core/workspace';
import { z } from 'zod';
import type { VerificationProject } from '../contracts/project.js';
import {
  validateScreenshot,
  type EvidenceRecorder,
} from '../delivery/evidence.js';

const operations = [
  'open',
  'snapshot',
  'click',
  'press',
  'fill',
  'type',
  'scroll',
  'swipe',
  'get',
  'is',
  'find',
  'wait',
  'back',
  'hover',
  'select',
  'check',
  'uncheck',
  'help',
  'screenshot',
] as const;
type Operation = (typeof operations)[number];
const flags: Partial<Record<Operation, string[]>> = {
  snapshot: ['-i', '--interactive', '--depth', '-d', '--compact'],
  click: ['--settle'],
  press: ['--settle'],
  fill: ['--settle'],
  type: ['--settle'],
  scroll: ['--settle', '--selector'],
  swipe: ['--settle'],
  find: ['--name', '--exact'],
  wait: ['--text', '--url', '--load', '--timeout'],
};

export const qaCommandSchema = z.strictObject({
  targetId: z.string(),
  operation: z.enum(operations),
  args: z.array(z.string().max(8_000)).max(30),
});

export const qaResultSchema = z.strictObject({
  evidenceId: z.string(),
  path: z.string(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  image: z.string().optional(),
});

export interface QaToolOptions {
  project: VerificationProject;
  automationSandbox: LocalSandbox;
  evidence: EvidenceRecorder;
  session: string;
  browserConfig: string;
  signal: AbortSignal;
}

export async function prepareQaArguments(
  operation: Operation,
  args: string[],
  destination: string,
  evidence: EvidenceRecorder,
): Promise<string[]> {
  for (const arg of args) {
    if (
      arg.startsWith('-') &&
      !flags[operation]?.includes(arg) &&
      !/^-\d+$/.test(arg)
    )
      throw new Error('This QA flag is not allowed.');
  }
  if (operation === 'open') {
    if (args.length)
      throw new Error('open uses the configured target, without arguments.');
    return [destination];
  }
  if (
    operation === 'help' &&
    (args.length !== 1 || !operations.includes(args[0] as Operation))
  )
    throw new Error('Request help for one supported operation.');
  if (operation === 'screenshot') {
    if (args.length)
      throw new Error(
        'screenshot uses a controller-owned path, without arguments.',
      );
    await mkdir(evidence.directory, { recursive: true, mode: 0o700 });
    return [join(evidence.directory, `${randomUUID()}.png`)];
  }
  return args;
}

export async function executeQaCommand(
  options: QaToolOptions,
  input: {
    kind: 'browser' | 'device';
    targetId: string;
    operation: Operation | 'viewport';
    command: string;
    args: string[];
    screenshot: string | undefined;
  },
) {
  options.signal.throwIfAborted();
  let result;
  try {
    result = await options.automationSandbox.executeCommand!(
      input.command,
      input.args,
      {
        abortSignal: options.signal,
        timeout: 120_000,
      },
    );
  } catch {
    options.signal.throwIfAborted();
    result = {
      exitCode: -1,
      stdout: '',
      stderr: 'Could not execute the configured QA tool.',
    };
  }
  let image: string | undefined;
  if (input.screenshot && result.exitCode === 0) {
    try {
      await validateScreenshot(input.screenshot);
      image = (await readFile(input.screenshot)).toString('base64');
    } catch {
      result = {
        ...result,
        exitCode: 1,
        stderr:
          'Screenshot output is missing or is not a valid PNG file under 10 MB.',
      };
    }
  }
  options.signal.throwIfAborted();
  const evidence = await options.evidence.record(
    {
      kind: input.screenshot ? 'screenshot' : input.kind,
      targetId: input.targetId,
      operation: input.operation,
      exitCode: result.exitCode,
    },
    { args: input.args, ...result },
    result.exitCode === 0 ? input.screenshot : undefined,
  );
  return {
    evidenceId: evidence.id,
    path: evidence.path,
    exitCode: result.exitCode,
    stdout: result.stdout.slice(-24_000),
    stderr: result.stderr.slice(-8_000),
    ...(image ? { image } : {}),
  };
}

/** Present live UI captures without giving the agent a file-reading tool. */
export function qaModelOutput(output: z.infer<typeof qaResultSchema>) {
  const { evidenceId, exitCode, stdout, stderr, image } = output;
  return {
    type: 'content',
    value: [
      {
        type: 'text',
        text: JSON.stringify({ evidenceId, exitCode, stdout, stderr }),
      },
      ...(image
        ? [{ type: 'media', data: image, mediaType: 'image/png' }]
        : []),
    ],
  };
}
