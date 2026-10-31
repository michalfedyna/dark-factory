import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IssueBrief } from '../contracts/issue.js';

export function createOutputWriter(
  directory: string,
  print: (json: string) => void,
) {
  return async (id: string, brief: IssueBrief): Promise<string> => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${id}.json`);
    const json = JSON.stringify(brief, null, 2);
    await writeFile(path, `${json}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    print(json);
    return path;
  };
}
