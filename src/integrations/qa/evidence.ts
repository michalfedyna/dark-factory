import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Evidence } from '../../contracts/delivery.js';

export function createEvidence(
  directory: string,
  revision: string,
  round: number,
) {
  const records: Evidence[] = [];
  return {
    records,
    directory,
    async record(
      input: Omit<Evidence, 'id' | 'path' | 'revision'>,
      output: unknown,
      screenshot?: string,
    ) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const id = `r${round}-e${records.length + 1}`;
      const path = join(directory, `${id}.json`);
      await writeFile(
        path,
        JSON.stringify({ ...input, revision, output }, null, 2),
        { mode: 0o600, flag: 'wx' },
      );
      const record: Evidence = {
        ...input,
        id,
        revision,
        path: screenshot ?? path,
      };
      records.push(record);
      return record;
    },
  };
}

export async function validateScreenshot(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size < 8 || stat.size > 10 * 1024 * 1024)
    throw new Error('Screenshot must be a regular PNG file under 10 MB.');
  const content = await readFile(path);
  if (
    !content
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error('Screenshot is not a PNG image.');
}

export type EvidenceRecorder = ReturnType<typeof createEvidence>;
