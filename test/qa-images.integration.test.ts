import { join } from 'node:path';
import { LocalSandbox } from '@mastra/core/workspace';
import { expect, test, vi } from 'vitest';
import { createQa } from '../src/agents/qa.js';
import { createEvidence } from '../src/delivery/evidence.js';
import { createQaTools } from '../src/tools/qa.js';
import { brief } from './fixtures/brief.js';
import { projectPlan, png } from './fixtures/delivery.js';
import { createModelProvider } from './fixtures/model-provider.js';
import { installQaAutomation } from './fixtures/integration.js';

test.each([
  ['chat', false],
  ['chat', true],
  ['responses', false],
  ['responses', true],
] as const)(
  'QA sends candidate screenshots and supplied references as image input (%s, streaming: %s)',
  async (api, streaming) => {
    const provider = await createModelProvider(api, 'delivery');
    vi.spyOn(globalThis, 'fetch').mockImplementation(provider.modelFetch);
    const bin = await installQaAutomation(provider.directory);
    const sandbox = new LocalSandbox({
      workingDirectory: provider.directory,
      timeout: 0,
    });
    const project = {
      ...projectPlan,
      browserCommand: join(bin, 'agent-browser'),
      targets: [
        {
          id: 'web',
          kind: 'web' as const,
          url: 'http://localhost:3000',
          start: { command: 'unused', args: [] },
          screenshots: true,
        },
      ],
    };
    const evidence = createEvidence(
      join(provider.directory, 'evidence'),
      'candidate',
      1,
    );
    const reference = {
      id: 'design-1',
      name: 'shipping.png',
      path: 'docs/design/shipping.png',
      image: Buffer.concat([png, Buffer.from('design-reference')]).toString(
        'base64',
      ),
    };
    try {
      const report = await createQa(
        provider.config.model,
        'test-key',
      )({
        context: {
          requirements: brief.requirements,
          references: [{ id: reference.id, name: reference.name }],
          acceptanceCriteria: brief.acceptanceCriteria,
          constraints: [],
          targets: project.targets,
          evidence: [],
        },
        tools: createQaTools({
          project,
          automationSandbox: sandbox,
          evidence,
          session: 'run-r1',
          browserConfig: join(provider.directory, 'browser.json'),
          signal: provider.controller.signal,
          references: [reference],
        }),
        signal: provider.controller.signal,
        ...(streaming ? { observe: () => {} } : {}),
      });
      expect(report.verdict).toBe('pass');
      const wire = JSON.stringify(provider.modelRequests);
      expect(wire).toMatch(/"type":"(?:image_url|input_image)"/);
      expect(wire).toContain(`data:image/png;base64,${png.toString('base64')}`);
      expect(wire).toContain(`data:image/png;base64,${reference.image}`);
      expect(evidence.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'screenshot', exitCode: 0 }),
        ]),
      );
    } finally {
      await sandbox.destroy();
      await provider.close();
    }
  },
);
