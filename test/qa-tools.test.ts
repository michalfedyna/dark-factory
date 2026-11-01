import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSandbox } from '@mastra/core/workspace';
import { afterEach, expect, test } from 'vitest';
import { createEvidence } from '../src/integrations/qa/evidence.js';
import { createQaTools } from '../src/tools/qa.js';
import { deliveryConfig, png } from './fixtures/delivery.js';

const resources: { directory: string; sandbox: LocalSandbox }[] = [];
afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ directory, sandbox }) => {
      await sandbox.destroy();
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function setup(badImage = false) {
  const directory = await mkdtemp(join(tmpdir(), 'darkfactory-qa-'));
  const executable = join(directory, 'qa-cli.mjs');
  const log = join(directory, 'invocation.json');
  await writeFile(
    executable,
    `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.writeFileSync(process.env.QA_LOG, JSON.stringify({args, key: process.env.DARKFACTORY_API_KEY ?? null}));\nconst screenshot = args.indexOf('screenshot');\nif (screenshot !== -1) fs.writeFileSync(args[screenshot + 1], ${badImage ? "Buffer.from('not-an-image')" : `Buffer.from('${png.toString('base64')}', 'base64')`});\nconsole.log('UI operation complete');\n`,
  );
  await chmod(executable, 0o700);
  const sandbox = new LocalSandbox({
    workingDirectory: directory,
    env: { QA_LOG: log },
  });
  resources.push({ directory, sandbox });
  const evidence = createEvidence(join(directory, 'evidence'), 'candidate', 1);
  const browserConfig = join(directory, 'browser.json');
  await writeFile(browserConfig, '{}');
  const config = {
    ...deliveryConfig,
    browserCommand: executable,
    deviceCommand: executable,
    targets: [
      {
        id: 'web',
        kind: 'web' as const,
        url: 'http://localhost:3000',
        start: { command: 'node', args: ['server.js'], timeoutMs: 120_000 },
        screenshots: true,
      },
      {
        id: 'ios',
        kind: 'mobile' as const,
        platform: 'ios' as const,
        app: 'com.example.app',
        device: 'iPhone test',
        prepare: { command: 'node', args: ['build.js'], timeoutMs: 120_000 },
        screenshots: true,
      },
    ],
  };
  const options = {
    config,
    sandbox,
    evidence,
    session: 'run-r1',
    browserConfig,
    signal: new AbortController().signal,
  };
  const tools = createQaTools(options);
  return {
    directory,
    evidence,
    tools,
    options,
    invocation: async () =>
      JSON.parse(await readFile(log, 'utf8')) as {
        args: string[];
        key: string | null;
      },
  };
}

test('web QA invokes agent-browser with a run-scoped session and the approved URL', async () => {
  const { tools, evidence, invocation } = await setup();
  await expect(
    tools.agent_browser!.execute!(
      { targetId: 'web', operation: 'open', args: [] },
      {},
    ),
  ).resolves.toMatchObject({ exitCode: 0, evidenceId: 'r1-e1' });
  const call = await invocation();
  expect(call.args).toContain('run-r1-web');
  expect(call.args.slice(-2)).toEqual(['open', 'http://localhost:3000']);
  expect(call.args).toContain('--allowed-domains');
  expect(call.key).toBeNull();
  expect(evidence.records[0]).toMatchObject({
    kind: 'browser',
    operation: 'open',
    revision: 'candidate',
    targetId: 'web',
  });
});
test('mobile QA invokes agent-device with the configured native platform and device', async () => {
  const { tools, evidence, invocation } = await setup();
  await tools.agent_device!.execute!(
    { targetId: 'ios', operation: 'open', args: [] },
    {},
  );
  expect((await invocation()).args).toEqual([
    'open',
    'com.example.app',
    '--session',
    'run-r1-ios',
    '--platform',
    'ios',
    '--device',
    'iPhone test',
  ]);
  expect(evidence.records[0]?.kind).toBe('device');
});
test.each([
  ['open', ['https://unapproved.example']],
  ['snapshot', ['--session', 'other']],
  ['click', ['--config=/private/config']],
  ['wait', ['--platform', 'web']],
] as const)(
  'rejects target or global policy overrides: %s %j',
  async (operation, args) => {
    const { tools, evidence } = await setup();
    await expect(
      tools.agent_browser!.execute!(
        { targetId: 'web', operation, args: [...args] },
        {},
      ),
    ).rejects.toThrow();
    expect(evidence.records).toHaveLength(0);
  },
);
test('screenshot paths are controller-owned and only validated files count as evidence', async () => {
  const { tools, evidence, directory } = await setup();
  await expect(
    tools.agent_browser!.execute!(
      { targetId: 'web', operation: 'screenshot', args: [] },
      {},
    ),
  ).resolves.toMatchObject({ exitCode: 0 });
  const image = evidence.records[0]!;
  expect(image.kind).toBe('screenshot');
  expect(image.path.startsWith(join(directory, 'evidence'))).toBe(true);
  expect(await readFile(image.path)).toEqual(png);
});
test('a tool returning success without a valid image is failed evidence', async () => {
  const { tools, evidence } = await setup(true);
  await expect(
    tools.agent_browser!.execute!(
      { targetId: 'web', operation: 'screenshot', args: [] },
      {},
    ),
  ).resolves.toMatchObject({ exitCode: 1 });
  expect(evidence.records[0]?.exitCode).toBe(1);
});
test('help output cannot masquerade as a successful UI snapshot', async () => {
  const { tools, evidence } = await setup();
  await tools.agent_browser!.execute!(
    { targetId: 'web', operation: 'help', args: ['snapshot'] },
    {},
  );
  expect(evidence.records[0]?.operation).toBe('help');
});

test('browser and device tools cannot operate on the other target kind', async () => {
  const { tools, evidence } = await setup();
  await expect(
    tools.agent_browser!.execute!(
      { targetId: 'ios', operation: 'open', args: [] },
      {},
    ),
  ).rejects.toThrow('Unknown web QA target');
  await expect(
    tools.agent_device!.execute!(
      { targetId: 'web', operation: 'open', args: [] },
      {},
    ),
  ).rejects.toThrow('Unknown mobile QA target');
  expect(evidence.records).toHaveLength(0);
});

test('QA exposes only integrations applicable to the configured targets', async () => {
  const { options } = await setup();
  const web = createQaTools({
    ...options,
    config: {
      ...options.config,
      targets: options.config.targets.filter((target) => target.kind === 'web'),
    },
  });
  expect(web.agent_browser).toBeDefined();
  expect(web.agent_device).toBeUndefined();
  const mobile = createQaTools({
    ...options,
    config: {
      ...options.config,
      targets: options.config.targets.filter(
        (target) => target.kind === 'mobile',
      ),
    },
  });
  expect(mobile.agent_device).toBeDefined();
  expect(mobile.agent_browser).toBeUndefined();
  expect(
    createQaTools({ ...options, config: { ...options.config, targets: [] } }),
  ).toEqual({});
});

test('device screenshots use controller-owned paths and native evidence', async () => {
  const { tools, evidence, invocation } = await setup();
  await expect(
    tools.agent_device!.execute!(
      { targetId: 'ios', operation: 'screenshot', args: [] },
      {},
    ),
  ).resolves.toMatchObject({ exitCode: 0 });
  expect(evidence.records[0]).toMatchObject({
    kind: 'screenshot',
    operation: 'screenshot',
    targetId: 'ios',
  });
  expect((await invocation()).args).toContain('--platform');
  expect(await readFile(evidence.records[0]!.path)).toEqual(png);
});

test('neither tool accepts agent-selected screenshot output paths', async () => {
  const { tools, evidence } = await setup();
  await expect(
    tools.agent_browser!.execute!(
      { targetId: 'web', operation: 'screenshot', args: ['../source.png'] },
      {},
    ),
  ).rejects.toThrow('controller-owned path');
  await expect(
    tools.agent_device!.execute!(
      { targetId: 'ios', operation: 'screenshot', args: ['../source.png'] },
      {},
    ),
  ).rejects.toThrow('controller-owned path');
  expect(evidence.records).toHaveLength(0);
});

test('device help cannot count as a successful UI snapshot', async () => {
  const { tools, evidence, invocation } = await setup();
  await tools.agent_device!.execute!(
    { targetId: 'ios', operation: 'help', args: ['snapshot'] },
    {},
  );
  expect((await invocation()).args.slice(0, 2)).toEqual(['help', 'snapshot']);
  expect(evidence.records[0]?.operation).toBe('help');
});
