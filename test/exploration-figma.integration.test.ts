import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createExploration } from '../src/agents/exploration.js';
import { issueBriefSchema } from '../src/contracts/issue.js';
import type { Ask } from '../src/contracts/interaction.js';
import { createFigmaProvider } from './fixtures/figma-provider.js';

const source = 'https://www.figma.com/design/DesignKey/Screen?node-id=1-2';

test.each([
  ['chat', false, false],
  ['responses', false, false],
  ['chat', true, true],
  ['responses', true, true],
] as const)(
  'exploration sees PNGs before confirmation, without design specs (%s, streaming: %s, follow-up: %s)',
  async (api, streaming, followUp) => {
    const provider = await createFigmaProvider(
      api,
      followUp ? 'exploration-figma-follow-up' : 'exploration-figma',
    );
    try {
      const ask = vi.fn<Ask>().mockImplementation((question) => {
        if (question.question === 'Which Figma design?') {
          expect(provider.restFetch).not.toHaveBeenCalled();
          return Promise.resolve(source);
        }
        expect(provider.restFetch).toHaveBeenCalledOnce();
        return Promise.resolve('Confirmed');
      });
      const result = await createExploration(
        provider.config.model,
        'test-key',
        {
          figma: provider.config.figma,
          figmaToken: 'private-figma-token',
          ...(streaming ? { debug: vi.fn() } : {}),
        },
      )(
        followUp
          ? 'Build the export screen'
          : `Build the export screen from ${source}`,
        ask,
        provider.controller.signal,
      );
      expect(issueBriefSchema.parse(result)).toMatchObject({
        readiness: 'ready',
        confirmedByUser: true,
      });
      expect(ask).toHaveBeenCalledTimes(followUp ? 2 : 1);
      expect(provider.restFetch.mock.calls[0]?.[0]).toEqual(
        new URL(
          'https://api.figma.com/v1/images/DesignKey?ids=1%3A2&format=png',
        ),
      );
      expect(provider.restFetch.mock.calls[0]?.[1]?.headers).toEqual({
        'X-Figma-Token': 'private-figma-token',
      });
      const requests = JSON.stringify(provider.modelRequests);
      expect(/"type":"(?:image_url|input_image)"/.test(requests)).toBe(true);
      expect(requests).toContain('data:image/png;base64,');
      expect(requests).not.toContain('private-figma-token');
      const contexts = await readFile(
        join(provider.directory, 'agent-contexts.jsonl'),
        'utf8',
      );
      const firstContext = JSON.parse(contexts.trim().split('\n')[0]!) as {
        tools: string[];
      };
      expect(firstContext.tools.sort()).toEqual(['ask', 'figma']);
      expect(contexts).not.toContain('private-figma-token');
    } finally {
      await provider.close();
    }
  },
);

test.each(['missing-token', 'forbidden'] as const)(
  'exploration can discuss unavailable designs without inventing a preview (%s)',
  async (failure) => {
    const provider = await createFigmaProvider(
      'responses',
      'exploration-figma-unavailable',
    );
    provider.restFetch.mockResolvedValue(
      new Response('private upstream details', { status: 403 }),
    );
    try {
      const ask = vi.fn<Ask>().mockResolvedValue('Stop for now');
      const result = await createExploration(
        provider.config.model,
        'test-key',
        {
          figma: { tokenEnv: 'FIGMA_TEST_TOKEN', auth: 'personal' },
          ...(failure === 'forbidden'
            ? { figmaToken: 'private-figma-token' }
            : {}),
        },
      )(`Build the screen from ${source}`, ask, provider.controller.signal);
      expect(issueBriefSchema.parse(result)).toMatchObject({
        readiness: 'needs-clarification',
        confirmedByUser: false,
      });
      expect(ask).toHaveBeenCalledOnce();
      expect(provider.restFetch).toHaveBeenCalledTimes(
        failure === 'forbidden' ? 1 : 0,
      );
      const requests = JSON.stringify(provider.modelRequests);
      expect(requests).toContain(
        failure === 'forbidden' ? 'Figma REST 403' : 'Set FIGMA_TEST_TOKEN',
      );
      expect(requests).not.toContain('private upstream details');
      expect(requests).not.toContain('private-figma-token');
    } finally {
      await provider.close();
    }
  },
);
