#!/usr/bin/env node
// Offline browser/device substitute. No real browser, simulator, or network.
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const args = process.argv.slice(2);
const screenshot = args.indexOf('screenshot');
if (screenshot !== -1)
  writeFileSync(
    args[screenshot + 1],
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
process.stdout.write('Offline UI operation completed\n');
