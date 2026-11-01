import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalSandbox } from '@mastra/core/workspace';
import { createRunArtifacts } from '../../src/delivery/artifacts.js';
import { createTestTool } from '../../src/tools/test.js';
import { projectPlan } from './delivery.js';
import { installQaAutomation } from './integration.js';

/** Fail loudly if a scenario unexpectedly requests progress testing. */
export function unusedTestTool(signal: AbortSignal) {
  return createTestTool({
    signal,
    run: () => Promise.reject(new Error('Unexpected progress test.')),
  });
}

export async function createProgressTestResources(directory: string) {
  const repository = join(directory, 'repository');
  await mkdir(repository);
  await writeFile(join(repository, 'progress.txt'), 'Current progress');
  const bin = await installQaAutomation(directory);
  const artifacts = createRunArtifacts(join(directory, 'run'));
  await artifacts.initialize();
  const browserConfig = join(directory, 'browser.json');
  await writeFile(browserConfig, '{}');
  const automationSandbox = new LocalSandbox({
    workingDirectory: directory,
    timeout: 0,
  });
  return {
    repository,
    close: () => automationSandbox.destroy(),
    run: {
      runId: 'run',
      directory: join(directory, 'run'),
      artifacts,
      project: {
        ...projectPlan,
        browserCommand: join(bin, 'agent-browser'),
        deviceCommand: join(bin, 'agent-device'),
      },
      projectSandboxOptions: { workingDirectory: repository, timeout: 0 },
      automationSandbox,
      browserConfig,
    },
  };
}
