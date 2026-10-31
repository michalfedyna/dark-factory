#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createProgram } from './program.js';

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

try {
  await createProgram(version).parseAsync(process.argv);
} catch (error) {
  process.stderr.write(
    `Error: ${error instanceof Error ? error.message : 'Factory failed.'}\n`,
  );
  process.exitCode = 1;
}
