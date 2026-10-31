import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
const { parseAsync, createProgram } = vi.hoisted(() => {
  const parseAsync = vi
    .fn<(args: string[]) => Promise<void>>()
    .mockResolvedValue(undefined);
  return { parseAsync, createProgram: vi.fn().mockReturnValue({ parseAsync }) };
});

vi.mock('../src/cli/program.js', () => ({ createProgram }));

test('the entry point loads the package version and forwards process arguments', async () => {
  await import('../src/cli/index.js');

  expect(createProgram).toHaveBeenCalledTimes(1);
  expect(createProgram).toHaveBeenCalledWith(packageJson.version);
  expect(parseAsync).toHaveBeenCalledTimes(1);
  expect(parseAsync).toHaveBeenCalledWith(process.argv);
});
