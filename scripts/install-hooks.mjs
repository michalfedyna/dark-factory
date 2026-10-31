import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = new URL('../', import.meta.url);
const lefthook = new URL('node_modules/lefthook/bin/index.js', root);

if (existsSync(new URL('.git', root)) && existsSync(lefthook)) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(lefthook), 'install'],
    {
      cwd: fileURLToPath(root),
      stdio: 'inherit',
    },
  );

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
