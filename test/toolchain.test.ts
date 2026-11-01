import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { LocalSandbox } from '@mastra/core/workspace';
import { afterEach, expect, test } from 'vitest';
import { toolchainEnvironment } from '../src/integrations/local/toolchain.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test('passes only tool locations and a UTF-8 locale, preferring real binaries over shims', async () => {
  const env = await toolchainEnvironment({
    PATH: '/host/shims',
    HOME: '/host/home',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    JAVA_HOME: '/host/jdk',
    ANDROID_HOME: '/host/sdk',
    ANDROID_SDK_ROOT: '/different/sdk',
    ANDROID_AVD_HOME: '/host/avds',
    ANDROID_USER_HOME: '/host/android-keys',
    DEVELOPER_DIR: '/host/Xcode/Developer',
    DARKFACTORY_API_KEY: 'secret',
    FIGMA_ACCESS_TOKEN: 'figma-secret',
    GITHUB_TOKEN: 'github-secret',
  });
  expect(env).toEqual({
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    JAVA_HOME: '/host/jdk',
    DEVELOPER_DIR: '/host/Xcode/Developer',
    ANDROID_HOME: '/host/sdk',
    ANDROID_SDK_ROOT: '/host/sdk',
    ANDROID_AVD_HOME: '/host/avds',
    PATH: [
      dirname(process.execPath),
      '/host/jdk/bin',
      '/host/sdk/platform-tools',
      '/host/sdk/emulator',
      '/host/shims',
    ].join(delimiter),
  });
});

test.each([
  ['darwin', 'Library/Android/sdk', 'en_US.UTF-8'],
  ['linux', 'Android/Sdk', 'C.UTF-8'],
] as const)(
  'discovers the SDK from the host home on %s',
  async (platform, relative, locale) => {
    const home = await mkdtemp(join(tmpdir(), 'darkfactory-toolchain-'));
    directories.push(home);
    const sdk = join(home, relative);
    const avds = join(home, '.android', 'avd');
    await mkdir(sdk, { recursive: true });
    await mkdir(avds, { recursive: true });
    const env = await toolchainEnvironment({ HOME: home }, platform);
    expect(env.ANDROID_HOME).toBe(sdk);
    expect(env.ANDROID_SDK_ROOT).toBe(sdk);
    expect(env.ANDROID_AVD_HOME).toBe(avds);
    expect(env.LANG).toBe(locale);
    expect(env).not.toHaveProperty('HOME');
  },
);

test('respects explicit SDK roots and UTF-8 locales without inventing missing SDKs', async () => {
  expect(
    await toolchainEnvironment({
      ANDROID_SDK_ROOT: '/explicit/sdk',
      LC_ALL: 'de_DE.utf8',
    }),
  ).toMatchObject({
    ANDROID_HOME: '/explicit/sdk',
    ANDROID_SDK_ROOT: '/explicit/sdk',
    LANG: 'de_DE.utf8',
    LC_ALL: 'de_DE.utf8',
  });
  expect(await toolchainEnvironment({})).not.toHaveProperty('ANDROID_HOME');
  expect(await toolchainEnvironment({})).not.toHaveProperty('ANDROID_AVD_HOME');
  expect(
    await toolchainEnvironment({ HOME: '/missing/home' }),
  ).not.toHaveProperty('ANDROID_AVD_HOME');
});

test.each([
  ['ANDROID_EMULATOR_HOME', 'emulator-config/avd'],
  ['ANDROID_USER_HOME', 'user-config/avd'],
  ['ANDROID_SDK_HOME', 'legacy-config/.android/avd'],
] as const)(
  'discovers AVDs through %s without exposing host Android preferences',
  async (key, relative) => {
    const home = await mkdtemp(join(tmpdir(), 'darkfactory-avd-'));
    directories.push(home);
    const avds = join(home, relative);
    await mkdir(avds, { recursive: true });
    const env = await toolchainEnvironment({
      HOME: '/unused/home',
      ANDROID_SDK_HOME: join(home, 'legacy-config'),
      ...(key !== 'ANDROID_SDK_HOME'
        ? { ANDROID_USER_HOME: join(home, 'user-config') }
        : {}),
      ...(key === 'ANDROID_EMULATOR_HOME'
        ? { ANDROID_EMULATOR_HOME: join(home, 'emulator-config') }
        : {}),
    });
    expect(env.ANDROID_AVD_HOME).toBe(avds);
    for (const name of [
      'HOME',
      'ANDROID_USER_HOME',
      'ANDROID_EMULATOR_HOME',
      'ANDROID_SDK_HOME',
    ])
      expect(env).not.toHaveProperty(name);
  },
);

test('real Mastra commands receive the toolchain environment and a private home, not credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'darkfactory-toolchain-command-'));
  directories.push(home);
  const sandbox = new LocalSandbox({
    workingDirectory: home,
    isolation: 'none',
    env: {
      ...(await toolchainEnvironment({
        JAVA_HOME: '/test/jdk',
        ANDROID_HOME: '/test/sdk',
        ANDROID_AVD_HOME: '/test/avds',
        ANDROID_USER_HOME: '/host/adb-keys',
        DARKFACTORY_API_KEY: 'private',
      })),
      HOME: home,
    },
  });
  try {
    if (!sandbox.executeCommand)
      throw new Error('Command execution unavailable');
    const result = await sandbox.executeCommand(process.execPath, [
      '-e',
      'console.log(JSON.stringify(process.env))',
    ]);
    expect(result.exitCode).toBe(0);
    const env: unknown = JSON.parse(result.stdout);
    expect(env).toMatchObject({
      HOME: home,
      JAVA_HOME: '/test/jdk',
      ANDROID_HOME: '/test/sdk',
      ANDROID_AVD_HOME: '/test/avds',
    });
    expect(env).not.toHaveProperty('DARKFACTORY_API_KEY');
    expect(env).not.toHaveProperty('ANDROID_USER_HOME');
    expect(result.stdout).toMatch(/UTF-8/);
  } finally {
    await sandbox.destroy();
  }
});
