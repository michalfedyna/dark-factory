import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { startCommand } from '../src/cli/start.js';
import { loadConfig } from '../src/config/load.js';

vi.mock('../src/config/load.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../src/factory/start.js', () => ({ startFactory: vi.fn() }));

const factoryPackage = fileURLToPath(
  new URL('../package.json', import.meta.url),
);
const callerDirectory = resolve(process.cwd(), '../target project');

afterEach(() => {
  vi.unstubAllEnvs();
});

test.each([
  ['dev', factoryPackage, callerDirectory, callerDirectory],
  ['start', factoryPackage, callerDirectory, callerDirectory],
  ['dev', factoryPackage, undefined, process.cwd()],
  ['start', factoryPackage, '', process.cwd()],
  [undefined, factoryPackage, callerDirectory, process.cwd()],
  ['test', factoryPackage, callerDirectory, process.cwd()],
  [
    'dev',
    resolve(callerDirectory, 'package.json'),
    callerDirectory,
    process.cwd(),
  ],
  ['start', undefined, callerDirectory, process.cwd()],
] as const)(
  'resolves relative config from the launch directory (script %s, package %s, INIT_CWD %s)',
  async (script, packagePath, initCwd, expectedDirectory) => {
    vi.stubEnv('npm_lifecycle_event', script);
    vi.stubEnv('npm_package_json', packagePath);
    vi.stubEnv('INIT_CWD', initCwd);
    const stopped = new Error('Stop before startup.');
    vi.mocked(loadConfig).mockRejectedValueOnce(stopped);

    await expect(startCommand({ config: 'config/factory.json' })).rejects.toBe(
      stopped,
    );

    expect(loadConfig).toHaveBeenCalledExactlyOnceWith(
      resolve(expectedDirectory, 'config/factory.json'),
    );
  },
);

test('keeps an absolute config path independent of the launch directory', async () => {
  vi.stubEnv('npm_lifecycle_event', 'dev');
  vi.stubEnv('npm_package_json', factoryPackage);
  vi.stubEnv('INIT_CWD', callerDirectory);
  const stopped = new Error('Stop before startup.');
  vi.mocked(loadConfig).mockRejectedValueOnce(stopped);

  await expect(startCommand({ config: factoryPackage })).rejects.toBe(stopped);

  expect(loadConfig).toHaveBeenCalledExactlyOnceWith(factoryPackage);
});
