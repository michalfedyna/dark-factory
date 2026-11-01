import type { LocalSandbox } from '@mastra/core/workspace';
import type { DeliveryRound } from '../contracts/delivery.js';
import type { Project } from '../contracts/project.js';
import type { Observe } from '../contracts/progress.js';
import type { RoundResources, RunResources } from './context.js';

export async function executeProjectCommand(
  projectSandbox: LocalSandbox,
  command: Project['setup'][number],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!projectSandbox.executeCommand)
    throw new Error('The project sandbox must support command execution.');
  const result = await projectSandbox.executeCommand(
    command.command,
    command.args,
    {
      timeout: command.timeoutMs,
      abortSignal: signal,
    },
  );
  signal.throwIfAborted();
  return result;
}

export async function runChecks(
  run: RunResources,
  resources: RoundResources,
  round: DeliveryRound,
  signal: AbortSignal,
  observe?: Observe,
): Promise<DeliveryRound> {
  const { project, projectSandbox, repository } = run;
  const { evidence } = resources;
  const findings = [...round.findings];
  const checks = [
    ...project.checks,
    ...project.targets.flatMap((target) =>
      target.kind === 'mobile'
        ? [{ ...target.prepare, id: `prepare-${target.id}` }]
        : [],
    ),
  ];
  for (const check of checks) {
    observe?.({ kind: 'check', id: check.id, status: 'started' });
    const result = await executeProjectCommand(projectSandbox, check, signal);
    observe?.({
      kind: 'check',
      id: check.id,
      status: result.exitCode === 0 ? 'passed' : 'failed',
    });
    const record = await evidence.record(
      {
        kind: 'check',
        targetId: null,
        operation: check.id,
        exitCode: result.exitCode,
      },
      { check, ...result },
    );
    if (result.exitCode !== 0)
      findings.push({
        source: 'checks',
        kind: 'defect',
        severity: 'blocking',
        description: `Check ${check.id} failed. See ${record.path}.`,
        criterionId: null,
        evidenceIds: [record.id],
      });
  }
  await repository.assertUnchanged(round.revision, signal);
  return { ...round, findings, evidence: [...evidence.records] };
}
