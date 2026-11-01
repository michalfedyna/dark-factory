import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

spawn(
  process.execPath,
  [
    fileURLToPath(new URL('./router.mjs', import.meta.url)),
    ...process.argv.slice(2, 4),
    'ignore-term',
  ],
  { stdio: 'ignore' },
);
process.on('SIGTERM', () => {
  process.exit(0);
});
