import { LocalSandbox } from '@mastra/core/workspace';
import { z } from 'zod';
import type { IssueBrief } from '../contracts/issue.js';
import { projectSchema } from '../contracts/project.js';
import { readBase } from '../integrations/git/repository.js';
import { approve } from './approval.js';
import type { DeliveryOptions } from './context.js';

/** Validate inspection and obtain approval before acquiring mutable resources. */
export async function approveProject(
  options: DeliveryOptions,
  brief: IssueBrief,
  signal: AbortSignal,
  maxRepairRounds: number,
) {
  options.progress('Inspecting repository');
  const project = projectSchema.parse(await options.inspect(brief, signal));
  signal.throwIfAborted();
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
  const accepted = await approve(
    options.ask,
    'Implement this brief?',
    JSON.stringify(
      {
        brief,
        repository: project.repository,
        baseRevision: base,
        project,
        isolation,
        maxRepairRounds,
        warning:
          'Project commands and browser/device automation run on this host. Use only trusted repositories and test accounts. Local sandboxing is not a complete security boundary. Your original checkout is not edited. Publication requires a separate approval.',
      },
      null,
      2,
    ),
    'Implement',
    'Stop',
    signal,
    'Implementation plan',
  );
  if (!accepted) throw new Error('Implementation was not approved.');
  return { project, base, isolation };
}
