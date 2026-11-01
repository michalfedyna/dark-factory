import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { createProgram } from '../src/cli/program.js';

const version = '2.3.4';
const description =
  'DarkFactory — an autonomous software factory powered by AI agents.';

function createTestProgram(programVersion = version) {
  const output = { stdout: '', stderr: '' };
  const program = createProgram(programVersion)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        output.stdout += text;
      },
      writeErr: (text) => {
        output.stderr += text;
      },
    });

  return { program, output };
}

describe('CLI program', () => {
  test('creates independent command instances', () => {
    expect(createProgram(version)).not.toBe(createProgram(version));
  });

  test.each(['--version', '-V'])(
    '%s prints the supplied version',
    async (flag) => {
      const { program, output } = createTestProgram();

      await expect(
        program.parseAsync([flag], { from: 'user' }),
      ).rejects.toMatchObject({
        code: 'commander.version',
        exitCode: 0,
      });
      expect(output.stdout).toBe(`${version}\n`);
      expect(output.stderr).toBe('');
    },
  );

  test.each(['--help', '-h'])('%s prints the command help', async (flag) => {
    const { program, output } = createTestProgram();

    await expect(
      program.parseAsync([flag], { from: 'user' }),
    ).rejects.toMatchObject({
      code: 'commander.helpDisplayed',
      exitCode: 0,
    });
    expect(output.stdout).toContain('Usage: dark [options]');
    expect(output.stdout).toContain(description);
    expect(output.stdout).toContain('-V, --version');
    expect(output.stdout).toContain('-h, --help');
    expect(output.stderr).toBe('');
  });

  test('no arguments prints help without exiting', async () => {
    const { program, output } = createTestProgram();

    await expect(program.parseAsync([], { from: 'user' })).resolves.toBe(
      program,
    );
    expect(output.stdout).toBe(program.helpInformation());
    expect(output.stdout).toContain('Usage: dark [options]');
    expect(output.stderr).toBe('');
  });

  test('start help advertises debug streaming', () => {
    const help = createProgram(version).commands[0]?.helpInformation();
    expect(help).toContain('--debug');
    expect(help).toContain(
      'Stream agent activity instead of Observer summaries',
    );
  });

  test('unknown options include a help hint', async () => {
    const { program, output } = createTestProgram();

    await expect(
      program.parseAsync(['--unknown'], { from: 'user' }),
    ).rejects.toMatchObject({
      code: 'commander.unknownOption',
      exitCode: 1,
    });
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain("unknown option '--unknown'");
    expect(output.stderr).toContain('(Run dark --help for usage.)');
  });

  test('unexpected arguments are rejected', async () => {
    const { program, output } = createTestProgram();

    await expect(
      program.parseAsync(['unknown'], { from: 'user' }),
    ).rejects.toMatchObject({
      code: 'commander.excessArguments',
      exitCode: 1,
    });
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('too many arguments');
  });
});

describe('CLI properties', () => {
  const propertyOptions = { numRuns: 100, seed: 20261031 };

  test('version output preserves any generated semantic version', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(fc.nat(65_535), fc.nat(65_535), fc.nat(65_535)),
        fc.constantFrom('--version', '-V'),
        async ([major, minor, patch], flag) => {
          const generatedVersion = `${major}.${minor}.${patch}`;
          const { program, output } = createTestProgram(generatedVersion);

          await expect(
            program.parseAsync([flag], { from: 'user' }),
          ).rejects.toMatchObject({ code: 'commander.version', exitCode: 0 });
          expect(output.stdout).toBe(`${generatedVersion}\n`);
          expect(output.stderr).toBe('');
        },
      ),
      propertyOptions,
    );
  });

  test('unknown generated flags are always rejected', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
        async (name) => {
          const flag = `--unknown-${name}`;
          const { program, output } = createTestProgram();

          await expect(
            program.parseAsync([flag], { from: 'user' }),
          ).rejects.toMatchObject({
            code: 'commander.unknownOption',
            exitCode: 1,
          });
          expect(output.stdout).toBe('');
          expect(output.stderr).toContain(`unknown option '${flag}'`);
          expect(output.stderr).toContain('(Run dark --help for usage.)');
        },
      ),
      propertyOptions,
    );
  });
});
