import { LocalSandbox } from '@mastra/core/workspace';
import { z } from 'zod';
import type { IssueBrief } from '../contracts/issue.js';
import { projectSchema } from '../contracts/project.js';
import { readBase } from '../integrations/git/repository.js';
import type { DeliveryOptions } from './context.js';

/** Validate inspection before acquiring mutable resources. */
export async function prepareProject(
  options: DeliveryOptions,
  brief: IssueBrief,
  signal: AbortSignal,
) {
  if (brief.readiness !== 'ready' || !brief.confirmedByUser)
    throw new Error('Delivery requires a confirmed, ready brief.');
  options.progress('Inspecting repository');
  const inspection = await options.inspect(brief, signal);
  signal.throwIfAborted();
  if ('blockers' in inspection) {
    (options.diagnostic ?? options.progress)(
      `Repository inspection blocked: ${inspection.blockers.join(' ')}`,
    );
    throw new Error('Repository inspection blocked.');
  }
  const project = projectSchema.parse(inspection);
  const base = await readBase(project.repository, project.baseBranch, signal);
  if (base !== project.baseRevision)
    throw new Error(
      'The base branch changed during inspection. Start a new run.',
    );
  const detection = z
    .object({
      available: z.boolean(),
      backend: z.enum(['none', 'seatbelt', 'bwrap']),
    })
    .parse(LocalSandbox.detectIsolation());
  if (!detection.available || detection.backend === 'none')
    throw new Error(
      'Native sandbox isolation is unavailable. Install Seatbelt or Bubblewrap before running project commands.',
    );
  const isolation = detection.backend;
  return { project, base, isolation };
}
