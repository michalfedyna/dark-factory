import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Identify roles from their real data contracts, never from instruction wording.
export function requestRole({ payload }) {
  if (payload?.instructions && payload?.target) return 'progress-test';
  if (payload?.searchResults) return 'search-cleanup';
  if (payload?.library) return 'documentation';
  if (payload?.events) return 'observer';
  if (payload?.patch !== undefined) return 'review';
  if (payload?.pendingCriteria) return 'sandbox-qa';
  if (payload?.sources && payload?.allowedPaths) return 'figma';
  if (payload?.allowedPaths) return 'implementation';
  if (payload?.targets) return 'qa';
  if (payload?.issue) return 'summary';
  return 'exploration';
}

export function scenarioReply(request, resultPath, mode) {
  const role = requestRole(request);
  const { payload, toolResults } = request;
  const prefix = payload?.evidence?.[0]?.id.split('-e')[0] ?? 'r1';
  if (role === 'progress-test') {
    const operations = [
      'open',
      'snapshot',
      ...(payload.target.screenshots ? ['screenshot'] : []),
    ];
    if (toolResults < operations.length)
      return {
        tool: {
          name:
            payload.target.kind === 'web' ? 'agent_browser' : 'agent_device',
          args: {
            targetId: payload.target.id,
            operation: operations[toolResults],
            args: [],
          },
        },
      };
    return {
      result: { status: 'passed', description: 'Observed current progress.' },
    };
  }
  if (
    mode === 'progress-test' &&
    (role === 'implementation' || role === 'figma')
  ) {
    if (toolResults === 0)
      return {
        tool: {
          name: 'test',
          args: JSON.parse(
            readFileSync(
              join(dirname(resultPath), 'progress-test.json'),
              'utf8',
            ),
          ),
        },
      };
    return {
      result:
        role === 'implementation'
          ? {
              summary: 'Tested progress.',
              blockers: ['Test complete.'],
              verification: null,
            }
          : {
              summary: 'Tested progress.',
              components: [],
              designSystem: [],
              implementationNotes: [],
              limitations: [],
              blockers: [],
            },
    };
  }
  if (role === 'search-cleanup')
    return {
      result: {
        results: payload.searchResults.map(({ index, title, snippet }) => ({
          index,
          title: title.replace(' docs', ' documentation'),
          snippet,
        })),
      },
    };
  if (role === 'documentation') {
    const actions = [
      {
        name: 'search_web',
        args: { query: `${payload.library} ${payload.version} official docs` },
      },
      { name: 'web_fetch', args: { url: 'https://docs.example.com/widgets' } },
    ];
    if (toolResults < actions.length) return { tool: actions[toolResults] };
    return {
      text: 'Version: widgets 1.0. Guide: import createWidget; pass options. Pitfalls: options are required. Sources: https://docs.example.com/widgets. Limits: none.',
    };
  }
  if (
    mode === 'documentation' &&
    (role === 'implementation' || role === 'figma')
  ) {
    if (toolResults === 0)
      return {
        tool: {
          name: 'agent-documentation',
          args: {
            prompt: JSON.stringify({
              library: 'widgets',
              version: '1.0',
              question: 'How do I create a widget?',
            }),
          },
        },
      };
    return {
      result:
        role === 'implementation'
          ? {
              summary: 'Consulted the documentation guide.',
              blockers: ['Test complete.'],
              verification: null,
            }
          : {
              summary: 'Consulted the documentation guide.',
              components: [],
              designSystem: [],
              implementationNotes: [],
              limitations: [],
              blockers: [],
            },
    };
  }
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
  if (role === 'figma') {
    const actions = [
      {
        name: 'figma',
        args: {
          source: payload.sources[0].url,
          operation: 'nodes',
          nodeIds: [payload.sources[0].nodeId],
        },
      },
      ...(mode === 'delivery-figma-images'
        ? [
            {
              name: 'figma',
              args: {
                source: payload.sources[0].url,
                operation: 'render',
                nodeIds: [payload.sources[0].nodeId],
                format: 'png',
              },
            },
          ]
        : []),
      {
        name: 'mastra_workspace_write_file',
        args: {
          path: 'ui-scaffold.tsx',
          content: 'export const Panel = () => null;',
        },
      },
    ];
    if (toolResults < actions.length) return { tool: actions[toolResults] };
    return {
      result: {
        summary: 'Scaffolded the export panel.',
        components: ['ui-scaffold.tsx: Panel'],
        designSystem: [],
        implementationNotes: [
          'Wire the export callback and replace sample content.',
        ],
        limitations: [],
        blockers: [],
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
    const followUp = mode === 'delivery-sandbox-qa-follow-up';
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
        verdict: followUp ? 'blocked' : failed ? 'changes-requested' : 'pass',
        criteria: payload.acceptanceCriteria.map(({ id }) => ({
          id,
          status: followUp ? 'blocked' : failed ? 'fail' : 'pass',
          evidenceIds: [`${prefix}-e${payload.evidence.length + 1}`],
          notes: 'Observed the candidate through a sandbox command.',
        })),
        ...(followUp
          ? {
              resolvedQuestions: [
                {
                  questionId: payload.questions[0].id,
                  evidenceIds: [`${prefix}-e${payload.evidence.length + 1}`],
                  notes: 'Observed the sandbox behavior.',
                },
              ],
              uiFollowUp: {
                criterionIds: ['AC1'],
                notes: `Compare the running native screen with ${payload.references[0].id}.`,
              },
            }
          : {}),
        findings: followUp
          ? [
              {
                source: 'qa',
                kind: 'question',
                severity: 'blocking',
                criterionId: 'AC1',
                description: 'Native visual comparison remains.',
                evidenceIds: [],
              },
            ]
          : failed
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
      ...(payload.references?.length
        ? [
            {
              name: 'qa_reference',
              args: { referenceId: payload.references[0].id },
            },
          ]
        : []),
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
    ].filter(
      (action) =>
        action.name === 'qa_reference' ||
        payload.targets.some((target) => target.id === action.args.targetId),
    );
    const failed = mode === 'delivery-qa-repair' && prefix === 'r1';
    const blocked = mode.startsWith('delivery-sandbox-qa') && !payload.followUp;
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
                  ...actions
                    .filter((action) => action.name !== 'qa_reference')
                    .map(
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
  if (role === 'exploration' && mode.startsWith('exploration-figma')) {
    const source = 'https://www.figma.com/design/DesignKey/Screen?node-id=1-2';
    const actions = [
      ...(mode === 'exploration-figma-follow-up'
        ? [
            {
              name: 'ask',
              args: {
                question: 'Which Figma design?',
                context: '',
                options: [],
              },
            },
          ]
        : []),
      { name: 'figma', args: { source, operation: 'preview' } },
      {
        name: 'ask',
        args: {
          question:
            mode === 'exploration-figma-unavailable'
              ? 'The design could not be previewed. Describe the screen or stop for now?'
              : 'Confirm the export screen?',
          context: '',
          options: [],
        },
      },
    ];
    if (toolResults < actions.length) return { tool: actions[toolResults] };
    const brief = JSON.parse(readFileSync(resultPath, 'utf8'));
    return {
      result: {
        ...brief,
        decisions: [
          ...brief.decisions,
          { question: 'Design reference?', answer: source },
        ],
        ...(mode === 'exploration-figma-unavailable'
          ? {
              readiness: 'needs-clarification',
              confirmedByUser: false,
              openQuestions: ['The design could not be previewed.'],
            }
          : {}),
      },
    };
  }
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
