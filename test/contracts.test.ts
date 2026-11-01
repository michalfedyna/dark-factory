import { describe, expect, test } from 'vitest';
import {
  answerSchema,
  issueInputSchema,
  questionSchema,
} from '../src/contracts/interaction.js';
import { issueBriefSchema } from '../src/contracts/issue.js';
import { brief } from './fixtures/brief.js';

describe('issue brief contract', () => {
  test('validates a complete brief', () => {
    expect(issueBriefSchema.parse(brief)).toEqual(brief);
  });
  test('rejects unknown fields and missing acceptance criteria', () => {
    expect(
      issueBriefSchema.safeParse({ ...brief, invented: true }).success,
    ).toBe(false);
    expect(
      issueBriefSchema.safeParse({ ...brief, acceptanceCriteria: [] }).success,
    ).toBe(false);
  });
  test('ready requires confirmation and no open questions', () => {
    expect(
      issueBriefSchema.safeParse({ ...brief, confirmedByUser: false }).success,
    ).toBe(false);
    expect(
      issueBriefSchema.safeParse({
        ...brief,
        openQuestions: ['Who owns this?'],
      }).success,
    ).toBe(false);
    expect(
      issueBriefSchema.safeParse({
        ...brief,
        readiness: 'needs-clarification',
        confirmedByUser: false,
        openQuestions: ['Who owns this?'],
      }).success,
    ).toBe(true);
  });
  test('requires unique IDs', () => {
    expect(
      issueBriefSchema.safeParse({
        ...brief,
        requirements: [brief.requirements[0], brief.requirements[0]],
      }).success,
    ).toBe(false);
  });
});

describe('interaction contracts', () => {
  test('trims input and rejects empty or oversized input', () => {
    expect(issueInputSchema.parse(' Export issues ')).toBe('Export issues');
    expect(answerSchema.parse(' CSV ')).toBe('CSV');
    expect(answerSchema.safeParse(' ').success).toBe(false);
    expect(issueInputSchema.safeParse('x'.repeat(16_001)).success).toBe(false);
  });
  test('validates question data without any presentation markup or transport IDs', () => {
    const question = {
      question: 'Which format?',
      context: '',
      options: ['CSV'],
    };
    expect(questionSchema.parse(question)).toEqual(question);
    expect(
      questionSchema.safeParse({ ...question, question: '' }).success,
    ).toBe(false);
    expect(
      questionSchema.safeParse({ ...question, html: '<input>' }).success,
    ).toBe(false);
  });
  test('accepts an optional plain-text context heading', () => {
    const question = {
      question: 'Implement?',
      context: 'Allowed paths: src',
      options: ['Implement', 'Stop'],
    };
    expect(
      questionSchema.parse({
        ...question,
        contextTitle: ' Implementation plan ',
      }).contextTitle,
    ).toBe('Implementation plan');
    for (const contextTitle of ['', ' ', 'x'.repeat(101)])
      expect(
        questionSchema.safeParse({ ...question, contextTitle }).success,
      ).toBe(false);
  });
});
