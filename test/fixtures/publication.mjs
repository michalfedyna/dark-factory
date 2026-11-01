#!/usr/bin/env node
// Stub publication only; all other Git operations still use real repositories.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const directory = dirname(fileURLToPath(import.meta.url));
const { git, base } = JSON.parse(
  readFileSync(join(directory, 'publication-fixture.json'), 'utf8'),
);
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
if (command === 'gh' || args.includes('push')) {
  appendFileSync(
    join(directory, 'publication-calls.jsonl'),
    `${JSON.stringify({ command, args })}\n`,
  );
  if (command === 'gh') {
    if (args[0] === 'api') process.stdout.write(`${base}\n`);
    else if (args[0] === 'pr' && args.includes('--draft'))
      process.stdout.write('https://github.com/example/project/pull/12\n');
    else process.exit(1);
  }
} else {
  const result = spawnSync(git, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
