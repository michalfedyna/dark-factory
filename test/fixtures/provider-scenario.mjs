import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Identify roles from their real data contracts, never from instruction wording.
export function requestRole({ payload }) {
  if (payload?.events) return 'observer';
  if (payload?.patch !== undefined) return 'review';
  if (payload?.blockedCriteria) return 'sandbox-qa';
  if (payload?.allowedPaths) return 'implementation';
  if (payload?.targets) return 'qa';
  if (payload?.issue) return 'summary';
  return 'exploration';
}

export function scenarioReply(request, resultPath, mode) {
  const role = requestRole(request);
  const { payload, toolResults } = request;
  const prefix = payload?.evidence?.[0]?.id.split('-e')[0] ?? 'r1';
  if (role === 'observer') {
    const thinking = payload.events.findLast(
      (event) => event.kind === 'reasoning',
    );
    return {
      result: {
        summary:
          mode === 'observer-silent'
            ? ''
            : thinking
              ? `${thinking.agent} is considering: ${thinking.text}`
              : `Current delivery stage: ${payload.stage}.`,
      },
    };
  }
  if (
    role === 'implementation' &&
    (mode === 'implementation-blocked' ||
      mode === 'implementation-blocked-with-plan')
  )
    return {
      result: {
        summary: 'Cannot proceed.',
        blockers: ['Missing external API contract.'],
        verification:
          mode === 'implementation-blocked-with-plan'
            ? JSON.parse(
                readFileSync(
                  join(dirname(resultPath), 'verification-plan.json'),
                  'utf8',
                ),
              )
            : null,
      },
    };
  if (role === 'implementation' && mode === 'delivery-scaffold') {
    const files = {
      '.gitignore': 'node_modules/\n',
      'feature.txt': 'implemented',
      'package.json': JSON.stringify({
        name: 'scaffolded-app',
        version: '1.0.0',
        scripts: {
          dev: 'node server.cjs',
          build: 'node --check server.cjs',
          test: 'node --test check.cjs',
        },
      }),
      'server.cjs':
        "const http = require('node:http'); const content = require('node:fs').readFileSync('feature.txt', 'utf8'); if (require.main === module) http.createServer((_req, res) => res.end(content)).listen(Number(process.argv[2]), '127.0.0.1'); module.exports = content;\n",
      'check.cjs':
        "const test = require('node:test'); const assert = require('node:assert/strict'); test('serves the implemented feature', () => assert.equal(require('./server.cjs'), 'implemented'));\n",
    };
    const actions = [
      ...Object.entries(files).map(([path, content]) => ({
        name: 'mastra_workspace_write_file',
        args: { path, content },
      })),
      {
        name: 'mastra_workspace_execute_command',
        args: {
          command:
            'npm install --package-lock-only --ignore-scripts --no-audit --no-fund',
        },
      },
    ];
    if (toolResults < actions.length) return { tool: actions[toolResults] };
    return {
      result: {
        summary: 'Scaffolded an executable app with scripts and a lockfile.',
        blockers: [],
        verification: JSON.parse(
          readFileSync(
            join(dirname(resultPath), 'verification-plan.json'),
            'utf8',
          ),
        ),
      },
    };
  }
  if (role === 'implementation')
    return toolResults === 0
      ? {
          tool: {
            name: 'mastra_workspace_write_file',
            args: {
              path: 'feature.txt',
              content: payload.repair ? 'implemented repaired' : 'implemented',
              overwrite: payload.repair !== null,
            },
          },
        }
      : {
          result: {
            summary:
              'Implemented feature.txt and verified the configured check.',
            blockers: [],
            verification: JSON.parse(
              readFileSync(
                join(dirname(resultPath), 'verification-plan.json'),
                'utf8',
              ),
            ),
          },
        };
  if (role === 'sandbox-qa') {
    const failed = mode === 'delivery-sandbox-qa-repair' && prefix === 'r1';
    const actions = [
      {
        name: 'mastra_workspace_execute_command',
        args: {
          command: `node -e "if (process.env.DARKFACTORY_API_KEY) process.exit(2); console.log(require('node:fs').readFileSync('feature.txt', 'utf8')); process.exit(${failed ? 1 : 0});"`,
        },
      },
      { name: 'qa_evidence', args: {} },
    ];
    if (toolResults < actions.length) return { tool: actions[toolResults] };
    return {
      result: {
        verdict: failed ? 'changes-requested' : 'pass',
        criteria: payload.acceptanceCriteria.map(({ id }) => ({
          id,
          status: failed ? 'fail' : 'pass',
          evidenceIds: [`${prefix}-e${payload.evidence.length + 1}`],
          notes: 'Observed the candidate through a sandbox command.',
        })),
        findings: failed
          ? [
              {
                source: 'qa',
                kind: 'defect',
                severity: 'blocking',
                criterionId: 'AC1',
                description:
                  'The sandbox behavior check failed. Repair the candidate.',
                evidenceIds: [`${prefix}-e${payload.evidence.length + 1}`],
              },
            ]
          : [],
      },
    };
  }
  if (role === 'qa') {
    const actions = [
      {
        name: 'agent_browser',
        args: { targetId: 'web', operation: 'open', args: [] },
      },
      ...(mode === 'delivery-responsive'
        ? [
            {
              name: 'agent_browser',
              args: {
                targetId: 'web',
                operation: 'viewport',
                args: ['1280', '800'],
              },
            },
          ]
        : []),
      {
        name: 'agent_browser',
        args: { targetId: 'web', operation: 'snapshot', args: [] },
      },
      {
        name: 'agent_browser',
        args: { targetId: 'web', operation: 'screenshot', args: [] },
      },
      ...(mode === 'delivery-responsive'
        ? [
            {
              name: 'agent_browser',
              args: {
                targetId: 'web',
                operation: 'viewport',
                args: ['390', '844'],
              },
            },
            {
              name: 'agent_browser',
              args: { targetId: 'web', operation: 'snapshot', args: [] },
            },
            {
              name: 'agent_browser',
              args: { targetId: 'web', operation: 'screenshot', args: [] },
            },
          ]
        : []),
      {
        name: 'agent_device',
        args: { targetId: 'ios', operation: 'open', args: [] },
      },
      ...(mode === 'delivery-long-qa'
        ? Array.from({ length: 40 }, () => ({
            name: 'agent_browser',
            args: { targetId: 'web', operation: 'snapshot', args: [] },
          }))
        : []),
      {
        name: 'agent_device',
        args: { targetId: 'ios', operation: 'snapshot', args: [] },
      },
      {
        name: 'agent_device',
        args: { targetId: 'ios', operation: 'screenshot', args: [] },
      },
    ].filter((action) =>
      payload.targets.some((target) => target.id === action.args.targetId),
    );
    const failed = mode === 'delivery-qa-repair' && prefix === 'r1';
    const blocked = mode.startsWith('delivery-sandbox-qa');
    return toolResults < actions.length
      ? { tool: actions[toolResults] }
      : {
          result: {
            verdict: blocked
              ? 'blocked'
              : failed
                ? 'changes-requested'
                : 'pass',
            criteria: [
              {
                id: 'AC1',
                status: blocked ? 'blocked' : failed ? 'fail' : 'pass',
                evidenceIds: [
                  ...payload.evidence.map((record) => record.id),
                  ...actions.map(
                    (_, index) =>
                      `${prefix}-e${payload.evidence.length + index + 1}`,
                  ),
                ],
                notes: 'Offline test checks and stub UI journeys completed.',
              },
            ],
            findings: blocked
              ? [
                  {
                    source: 'qa',
                    kind: 'question',
                    severity: 'blocking',
                    criterionId: 'AC1',
                    description: 'The remaining behavior needs sandbox access.',
                    evidenceIds: [],
                  },
                ]
              : failed
                ? [
                    {
                      source: 'qa',
                      kind: 'defect',
                      severity: 'blocking',
                      description: 'Repair the initial candidate.',
                      criterionId: 'AC1',
                      evidenceIds: [`${prefix}-e1`],
                    },
                  ]
                : [],
          },
        };
  }
  if (role === 'review') {
    const failed = mode === 'delivery-review-repair' && prefix === 'r1';
    const actions = [
      {
        name: 'mastra_workspace_read_file',
        args: { path: 'feature.txt' },
      },
      {
        name: 'mastra_workspace_execute_command',
        args: {
          command: `node -e "if (process.env.DARKFACTORY_API_KEY) process.exit(2); if (!require('node:fs').readFileSync('feature.txt', 'utf8').startsWith('implemented')) process.exit(1); console.log('Independent review command passed');"`,
        },
      },
    ];
    if (toolResults < actions.length) return { tool: actions[toolResults] };
    return {
      result: {
        verdict: failed ? 'changes-requested' : 'pass',
        summary:
          'Independently inspected feature.txt and the patch, and ran a command against the candidate.',
        findings: failed
          ? [
              {
                source: 'review',
                kind: 'defect',
                severity: 'blocking',
                description: 'Repair the initial implementation.',
                criterionId: 'AC1',
                evidenceIds: [`${prefix}-e1`],
              },
            ]
          : [],
      },
    };
  }
  if (role === 'summary')
    return {
      result: {
        title: 'feat: implement approved issue',
        changes: ['Add feature.txt.'],
        testing: ['Configured check and offline web/mobile QA passed.'],
        limitations: ['UI automation is stubbed in this offline test.'],
      },
    };
  return toolResults === 0
    ? {
        tool: {
          name: 'ask',
          args: {
            question: 'Which export format?',
            context: mode.startsWith('delivery')
              ? ''
              : 'Choose a format for the filtered issues.',
            options: ['CSV', 'JSON'],
          },
        },
      }
    : toolResults === 1
      ? {
          tool: {
            name: 'ask',
            args: {
              question: 'Start implementation?',
              contextTitle: 'Issue plan',
              context:
                'Export filtered issues as CSV. Confirmation starts implementation, verification, repairs, and draft PR publication, including screenshots, without further prompts.',
              options: ['Start', 'Revise'],
            },
          },
        }
      : {
          result: JSON.parse(
            resultPath ? readFileSync(resultPath, 'utf8') : '{}',
          ),
        };
}
