import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { factoryConfigSchema } from '../src/config/schema.js';
import { loadConfig } from '../src/config/load.js';

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
    expect(config.sandbox.isolation).toBe('none');
    expect(config.observer).toEqual({
      enabled: true,
      intervalMs: 15_000,
      timeoutMs: 10_000,
    });
    expect(config).not.toHaveProperty('ui');
  });
  test.each([
    { ui: { port: 4310 } },
    { typo: true },
    { model: { baseUrl: 'not a URL' } },
    { model: { baseUrl: 'file:///etc/passwd' } },
    { model: { baseUrl: 'https://example.com/v1' } },
    { model: { maxSteps: 0 } },
    { observer: { intervalMs: 0 } },
    { observer: { timeoutMs: 0 } },
    { observer: { modelId: ' ' } },
    { observer: { typo: true } },
    { sandbox: { isolation: 'auto' } },
    { sandbox: { isolation: false } },
    { sandbox: { typo: true } },
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
  test('allows explicitly opting into native isolation', () => {
    expect(
      factoryConfigSchema.parse({ sandbox: { isolation: 'native' } }).sandbox
        .isolation,
    ).toBe('native');
  });
  test('allows disabling summaries or selecting a separate observer model', () => {
    expect(
      factoryConfigSchema.parse({ observer: { enabled: false } }).observer
        .enabled,
    ).toBe(false);
    expect(
      factoryConfigSchema.parse({ observer: { modelId: 'fast-model' } })
        .observer.modelId,
    ).toBe('fast-model');
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
