import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSandbox } from '@mastra/core/workspace';
import { afterEach, expect, test, vi } from 'vitest';
import type { VerificationProject } from '../src/contracts/project.js';
import { createEvidence } from '../src/delivery/evidence.js';
import { createQaTools } from '../src/tools/qa.js';
import { qaResultSchema } from '../src/tools/qa-command.js';
import { projectPlan, png } from './fixtures/delivery.js';

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
  const project: VerificationProject = {
    ...projectPlan,
    browserCommand: executable,
    deviceCommand: executable,
    targets: [
      {
        id: 'web',
        kind: 'web' as const,
        url: 'http://localhost:3000',
        start: { command: 'node', args: ['server.js'] },
        screenshots: true,
      },
      {
        id: 'ios',
        kind: 'mobile' as const,
        platform: 'ios' as const,
        app: 'com.example.app',
        device: 'iPhone test',
        prepare: { command: 'node', args: ['build.js'] },
        screenshots: true,
      },
    ],
  };
  const options = {
    project,
    automationSandbox: sandbox,
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
test.each(['ENOENT', 'EACCES'])(
  'QA spawn failures retain private command, code, stack and cause (%s)',
  async (code) => {
    const { tools, options, evidence } = await setup();
    vi.spyOn(options.automationSandbox, 'executeCommand').mockRejectedValueOnce(
      Object.assign(new Error('Spawn failed'), {
        code,
        cause: new Error('Underlying failure'),
      }),
    );
    const result = await tools.agent_browser!.execute!(
      { targetId: 'web', operation: 'open', args: [] },
      {},
    );
    expect(result).toMatchObject({
      exitCode: -1,
      stderr: 'Could not execute the configured QA tool.',
    });
    const log = JSON.parse(
      await readFile(evidence.records[0]!.path, 'utf8'),
    ) as unknown;
    expect(log).toMatchObject({
      output: {
        command: options.project.browserCommand,
        error: {
          code,
          stack: expect.stringContaining('qa-tools.test.ts') as unknown,
          cause: { message: 'Underlying failure' },
        },
      },
    });
  },
);
test.each([
  ['390', '844'],
  ['1', '1'],
  ['10000', '10000'],
])('web QA records viewport resizing at %s by %s', async (width, height) => {
  const { tools, evidence, invocation, options } = await setup();
  await expect(
    tools.agent_browser!.execute!(
      { targetId: 'web', operation: 'viewport', args: [width, height] },
      {},
    ),
  ).resolves.toMatchObject({ exitCode: 0, evidenceId: 'r1-e1' });
  expect((await invocation()).args).toEqual([
    '--config',
    options.browserConfig,
    '--session',
    'run-r1-web',
    '--allowed-domains',
    'localhost',
    'set',
    'viewport',
    width,
    height,
  ]);
  expect(evidence.records[0]).toMatchObject({
    kind: 'browser',
    operation: 'viewport',
    revision: 'candidate',
    targetId: 'web',
  });
});
test.each([
  [],
  ['390'],
  ['390', '844', '2'],
  ['0', '844'],
  ['390', '-1'],
  ['390.5', '844'],
  ['10001', '844'],
  ['390', '10001'],
  ['1e3', '844'],
  ['Infinity', '844'],
  ['390', 'NaN'],
  [' 390', '844'],
  ['390', '--session=other'],
  ['390', '844', '--config', '/private/config'],
  ['headers', '{"Authorization":"secret"}'],
])(
  'rejects invalid viewport arguments without invoking the CLI: %j',
  async (...args) => {
    const { tools, evidence, invocation } = await setup();
    await expect(
      tools.agent_browser!.execute!(
        { targetId: 'web', operation: 'viewport', args },
        {},
      ),
    ).rejects.toThrow('viewport requires width and height');
    expect(evidence.records).toHaveLength(0);
    await expect(invocation()).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
test('viewport help uses the installed browser syntax but remains help evidence', async () => {
  const { tools, evidence, invocation } = await setup();
  await tools.agent_browser!.execute!(
    { targetId: 'web', operation: 'help', args: ['viewport'] },
    {},
  );
  expect((await invocation()).args.slice(-2)).toEqual(['set', '--help']);
  expect(evidence.records[0]?.operation).toBe('help');
  await expect(
    tools.agent_browser!.execute!(
      { targetId: 'web', operation: 'help', args: ['viewport', '390'] },
      {},
    ),
  ).rejects.toThrow('one supported operation');
  expect(evidence.records).toHaveLength(1);
});
test('viewport is browser-only and does not expose general browser settings', async () => {
  const { tools } = await setup();
  const input = {
    targetId: 'web',
    operation: 'viewport',
    args: ['390', '844'],
  };
  expect(
    await tools.agent_browser!.inputSchema!['~standard'].validate(input),
  ).not.toHaveProperty('issues');
  expect(
    await tools.agent_device!.inputSchema!['~standard'].validate(input),
  ).toHaveProperty('issues');
  expect(
    await tools.agent_browser!.inputSchema!['~standard'].validate({
      ...input,
      operation: 'set',
    }),
  ).toHaveProperty('issues');
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
  ['ios', '3F85C83A-2821-4DB5-A41F-50F19E6FE553', '--udid'],
  ['android', 'emulator-5580', '--serial'],
  ['android', 'Resizable Experimental', '--device'],
  ['ios', undefined, undefined],
] as const)(
  'mobile QA selects %s target %s with the correct CLI selector',
  async (platform, device, flag) => {
    const { tools, options, invocation } = await setup();
    const target = options.project.targets[1]!;
    if (target.kind !== 'mobile') throw new Error('Expected a mobile target.');
    options.project.targets = [
      { ...target, platform, ...(device ? { device } : { device: undefined }) },
    ];
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
      platform,
      ...(flag && device ? [flag, device] : []),
    ]);
  },
);
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
test.each([
  ['agent_browser', 'web'],
  ['agent_device', 'ios'],
] as const)(
  '%s returns captured UI images directly to the model without file access',
  async (name, targetId) => {
    const { tools, evidence, directory, invocation } = await setup();
    const tool = tools[name]!;
    const result = qaResultSchema.parse(
      await tool.execute!({ targetId, operation: 'screenshot', args: [] }, {}),
    );
    const image = evidence.records[0]!;
    expect(image).toMatchObject({
      kind: 'screenshot',
      operation: 'screenshot',
      targetId,
      exitCode: 0,
    });
    expect(image.path.startsWith(join(directory, 'evidence'))).toBe(true);
    expect(await readFile(image.path)).toEqual(png);
    if (name === 'agent_device')
      expect((await invocation()).args).toContain('--platform');
    const output = tool.toModelOutput!(result);
    expect(output).toEqual({
      type: 'content',
      value: [
        {
          type: 'text',
          text: JSON.stringify({
            evidenceId: 'r1-e1',
            exitCode: 0,
            stdout: 'UI operation complete\n',
            stderr: '',
          }),
        },
        { type: 'media', data: png.toString('base64'), mediaType: 'image/png' },
      ],
    });
    expect(JSON.stringify(output)).not.toContain('path');
  },
);
test.each([
  ['agent_browser', 'web'],
  ['agent_device', 'ios'],
] as const)(
  '%s does not send invalid screenshot data to the model',
  async (name, targetId) => {
    const { tools, evidence } = await setup(true);
    const tool = tools[name]!;
    const result = qaResultSchema.parse(
      await tool.execute!({ targetId, operation: 'screenshot', args: [] }, {}),
    );
    expect(result).toMatchObject({ exitCode: 1 });
    expect(evidence.records[0]?.exitCode).toBe(1);
    expect(result).not.toHaveProperty('image');
    expect(tool.toModelOutput!(result)).toEqual({
      type: 'content',
      value: [
        {
          type: 'text',
          text: JSON.stringify({
            evidenceId: result.evidenceId,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }),
        },
      ],
    });
  },
);
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
    project: {
      ...options.project,
      targets: options.project.targets.filter(
        (target) => target.kind === 'web',
      ),
    },
  });
  expect(web.agent_browser).toBeDefined();
  expect(web.agent_device).toBeUndefined();
  const mobile = createQaTools({
    ...options,
    project: {
      ...options.project,
      targets: options.project.targets.filter(
        (target) => target.kind === 'mobile',
      ),
    },
  });
  expect(mobile.agent_device).toBeDefined();
  expect(mobile.agent_browser).toBeUndefined();
  expect(
    createQaTools({ ...options, project: { ...options.project, targets: [] } }),
  ).toEqual({});
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
