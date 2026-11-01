import type { LocalSandbox } from '@mastra/core/workspace';
import type { DeliveryRound } from '../contracts/delivery.js';
import type { VerificationPlan } from '../contracts/project.js';
import type { Observe } from '../contracts/progress.js';
import { CandidateChangedError } from '../integrations/git/repository.js';
import type { RoundResources, RunResources } from './context.js';

async function executeProjectCommand(
  projectSandbox: LocalSandbox,
  command: Omit<VerificationPlan['checks'][number], 'id'>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!projectSandbox.executeCommand)
    throw new Error('The project sandbox must support command execution.');
  const result = await projectSandbox.executeCommand(
    command.command,
    command.args,
    {
      timeout: 0,
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
  const { projectSandbox, repository } = run;
  const { project, evidence } = resources;
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
  try {
    await repository.assertUnchanged(round.revision, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof CandidateChangedError)) throw error;
    const record = await evidence.record(
      {
        kind: 'check',
        targetId: null,
        operation: 'candidate-unchanged',
        exitCode: 1,
      },
      { error: error.message },
    );
    findings.push({
      source: 'checks',
      kind: 'defect',
      severity: 'blocking',
      description:
        `Verification changed the candidate. Complete source-generating setup ` +
        `during implementation, before capture, and make checks and target ` +
        `preparation source-preserving. See ${record.path}.`,
      criterionId: null,
      evidenceIds: [record.id],
    });
  }
  return { ...round, findings, evidence: [...evidence.records] };
}
