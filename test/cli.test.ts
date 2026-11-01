import { expect, test } from 'vitest';
import { createProgram } from '../src/cli/program.js';

test('no arguments prints help without exiting', async () => {
  const output = { stdout: '', stderr: '' };
  const program = createProgram('2.3.4')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        output.stdout += text;
      },
      writeErr: (text) => {
        output.stderr += text;
      },
    });

  await expect(program.parseAsync([], { from: 'user' })).resolves.toBe(program);
  expect(output.stdout).toContain('Usage: dark [options]');
  expect(output.stdout).toContain('start');
  expect(output.stderr).toBe('');
});

test('start help exposes issue, config and debug options', () => {
  const help = createProgram('2.3.4').commands[0]?.helpInformation();
  expect(help).toContain('--issue <text>');
  expect(help).toContain('--config <path>');
  expect(help).toContain('--debug');
});
