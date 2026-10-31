import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createOutputWriter } from '../src/factory/output.js';
import { brief } from './fixtures/brief.js';

test('saves private, exclusive JSON files and prints only after a successful write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'darkfactory-output-'));
  const print = vi.fn<(json: string) => void>();
  try {
    const write = createOutputWriter(join(directory, 'issues'), print);
    const path = await write('test-id', brief);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(brief);
    expect(print).toHaveBeenCalledWith(JSON.stringify(brief, null, 2));
    if (process.platform !== 'win32')
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(
      write('test-id', { ...brief, title: 'Do not overwrite' }),
    ).rejects.toThrow();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(brief);
    expect(print).toHaveBeenCalledTimes(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
