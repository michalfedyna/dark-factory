import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { factoryConfigSchema } from '../src/config/schema.js';
import { loadConfig } from '../src/config/load.js';
import { deliveryConfig } from './fixtures/delivery.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('factory configuration', () => {
  test('defaults to Sol and a managed local router without web configuration', () => {
    const config = factoryConfigSchema.parse({});
    expect(config.model.id).toBe('gpt-6.1-sol');
    expect(config.model.api).toBe('responses');
    expect(config.router.managed).toBe(true);
    expect(config).not.toHaveProperty('ui');
  });
  test.each([
    { ui: { port: 4310 } },
    { typo: true },
    { model: { baseUrl: 'not a URL' } },
    { model: { baseUrl: 'file:///etc/passwd' } },
    { model: { baseUrl: 'https://example.com/v1' } },
    { model: { maxSteps: 0 } },
  ])('rejects invalid configuration %j', (input) => {
    expect(factoryConfigSchema.safeParse(input).success).toBe(false);
  });
  test('allows an explicit unmanaged remote endpoint', () => {
    expect(
      factoryConfigSchema.safeParse({
        router: { managed: false },
        model: { baseUrl: 'https://example.com/v1' },
      }).success,
    ).toBe(true);
  });
  test('delivery is opt-in and validates an explicit trusted local policy', () => {
    expect(factoryConfigSchema.parse({}).delivery).toBeUndefined();
    expect(
      factoryConfigSchema.parse({ delivery: deliveryConfig }).delivery,
    ).toEqual(deliveryConfig);
  });
  test.each([
    { trustedLocalExecution: false },
    { trustedLocalExecution: undefined },
    { checks: [] },
    { allowedPaths: [] },
    { allowedPaths: ['../source'] },
    { allowedPaths: ['/source'] },
    { allowedPaths: ['.git'] },
    { allowedPaths: ['.darkfactory/policy'] },
    { maxRepairRounds: -1 },
    { maxRepairRounds: 11 },
    { checks: [deliveryConfig.checks[0], deliveryConfig.checks[0]] },
    { targets: [{ id: 'web', kind: 'web', url: 'http://localhost:3000' }] },
    {
      targets: [
        { id: 'ios', kind: 'mobile', platform: 'ios', app: 'com.example.app' },
      ],
    },
    { githubRepo: 'https://github.com/example/project' },
  ])('rejects unsafe/incomplete delivery configuration %j', (overrides) => {
    expect(
      factoryConfigSchema.safeParse({
        delivery: { ...deliveryConfig, ...overrides },
      }).success,
    ).toBe(false);
  });
  test('loads relative paths from the config directory and explains validation errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'darkfactory-config-'));
    directories.push(directory);
    const path = join(directory, 'factory.json');
    await writeFile(path, '{}');
    expect((await loadConfig(path)).directory).toBe(directory);
    await writeFile(path, '{"model":{"maxSteps":0}}');
    await expect(loadConfig(path)).rejects.toThrow('model.maxSteps');
    await writeFile(path, 'not json');
    await expect(loadConfig(path)).rejects.toThrow(
      'Cannot read factory config',
    );
  });
});
