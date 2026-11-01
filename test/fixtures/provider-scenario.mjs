import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Identify roles from their real data contracts, never from instruction wording.
export function requestRole({ payload }) {
  if (payload?.events) return 'observer';
  if (payload?.patch !== undefined) return 'review';
  if (payload?.allowedPaths) return 'implementation';
  if (payload?.targets) return 'qa';
  if (payload?.issue) return 'summary';
  if (payload?.task) return 'inspection';
  return 'exploration';
}

export function scenarioReply(request, resultPath, mode) {
  const role = requestRole(request);
  const { payload, toolResults } = request;
  const prefix = payload?.evidence?.[0]?.id.split('-e')[0] ?? 'r1';
  if (role === 'observer') {
    const answered = payload.events.some(
      (event) =>
        event.kind === 'tool' &&
        event.agent === 'exploration' &&
        event.tool === 'ask' &&
        event.status === 'completed',
    );
    return {
      result: {
        summary: answered
          ? 'Clarification received; the brief is being prepared.'
          : 'Exploring the issue; no implementation has started.',
      },
    };
  }
  if (role === 'inspection')
    return toolResults === 0
      ? {
          tool: {
            name: 'mastra_workspace_read_file',
            args: { path: 'package.json' },
          },
        }
      : {
          result:
            mode === 'inspection-blocked'
              ? { plan: null, blockers: ['Missing native app identifier.'] }
              : {
                  plan: JSON.parse(
                    readFileSync(
                      join(dirname(resultPath), 'project-plan.json'),
                      'utf8',
                    ),
                  ),
                  blockers: [],
                },
        };
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
          },
        };
  if (role === 'qa') {
    const actions = [
      {
        name: 'agent_browser',
        args: { targetId: 'web', operation: 'open', args: [] },
      },
      {
        name: 'agent_browser',
        args: { targetId: 'web', operation: 'snapshot', args: [] },
      },
      {
        name: 'agent_browser',
        args: { targetId: 'web', operation: 'screenshot', args: [] },
      },
      {
        name: 'agent_device',
        args: { targetId: 'ios', operation: 'open', args: [] },
      },
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
    return toolResults < actions.length
      ? { tool: actions[toolResults] }
      : {
          result: {
            verdict: failed ? 'changes-requested' : 'pass',
            criteria: [
              {
                id: 'AC1',
                status: failed ? 'fail' : 'pass',
                evidenceIds: payload.targets.length
                  ? [`${prefix}-e1`, `${prefix}-e5`, `${prefix}-e8`]
                  : [`${prefix}-e1`],
                notes: 'Offline test checks and stub UI journeys completed.',
              },
            ],
            findings: failed
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
    return toolResults === 0
      ? {
          tool: {
            name: 'mastra_workspace_read_file',
            args: { path: 'feature.txt' },
          },
        }
      : {
          result: {
            verdict: failed ? 'changes-requested' : 'pass',
            summary: 'Independently inspected feature.txt and the patch.',
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
