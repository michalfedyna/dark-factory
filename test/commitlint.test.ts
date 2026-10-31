import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cliPath = fileURLToPath(
  new URL('../node_modules/@commitlint/cli/cli.js', import.meta.url),
);

function lintMessage(message: string) {
  const result = spawnSync(process.execPath, [cliPath, '--strict'], {
    cwd: root,
    input: message,
    encoding: 'utf8',
    timeout: 10_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

describe('Conventional Commits', () => {
  test.each([
    'feat(cli): add a command\n',
    'fix: handle empty input\n',
    'feat(cli)!: change argument names\n',
    'feat: change configuration\n\nBREAKING CHANGE: use a new configuration format\n',
  ])('accepts %j', (message) => {
    const result = lintMessage(message);

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  test.each([
    ['an unstructured message\n', 'type-empty'],
    ['feat: \n', 'subject-empty'],
    ['feat: add a command\nmissing blank line\n', 'body-leading-blank'],
  ])('rejects %j', (message, rule) => {
    const result = lintMessage(message);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(rule);
  });
});
