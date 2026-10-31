import type { IssueBrief } from '../../src/contracts/issue.js';

export const brief: IssueBrief = {
  schemaVersion: '1.0',
  title: 'Export filtered issues',
  kind: 'feature',
  problem: 'Users cannot export their filtered issues.',
  desiredOutcome: 'Users can download exactly the issues they selected.',
  users: ['Project maintainers'],
  scope: { in: ['CSV export of filtered issues'], out: ['Scheduled exports'] },
  requirements: [
    {
      id: 'R1',
      description: 'Export the current filtered issues as CSV.',
      priority: 'must',
    },
  ],
  acceptanceCriteria: [
    {
      id: 'AC1',
      given: 'A filtered issue list',
      when: 'The user exports it',
      then: 'A CSV containing only those issues is downloaded.',
    },
  ],
  constraints: [],
  assumptions: [],
  decisions: [{ question: 'Which format?', answer: 'CSV' }],
  risks: [],
  openQuestions: [],
  readiness: 'ready',
  confirmedByUser: true,
};
