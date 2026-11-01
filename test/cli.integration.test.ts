import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string; bin: { dark: string } };

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    encoding: 'utf8',
    timeout: 10_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

describe('compiled dark CLI', () => {
  test.each(['--version', '-V'])('%s prints the package version', (flag) => {
    const result = runCli([flag]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${packageJson.version}\n`);
    expect(result.stderr).toBe('');
  });

  test.each(['--help', '-h'])('%s prints help', (flag) => {
    const result = runCli([flag]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: dark [options]');
    expect(result.stdout).toContain('DarkFactory');
    expect(result.stdout).toContain('--version');
    expect(result.stdout).toContain('--help');
    expect(result.stderr).toBe('');
  });

  test('unknown options fail with a useful error', () => {
    const result = runCli(['--unknown']);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown option '--unknown'");
    expect(result.stderr).toContain('dark --help');
  });

  test('unexpected arguments fail instead of being ignored', () => {
    const result = runCli(['unknown']);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('too many arguments');
  });

  test('the dark bin points to the compiled Node.js entry point', () => {
    expect(packageJson.bin.dark).toBe('dist/cli/index.js');
    expect(readFileSync(cliPath, 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/);
  });
});
