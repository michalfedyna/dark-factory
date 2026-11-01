import type { Writable } from 'node:stream';
import { stripVTControlCharacters, styleText } from 'node:util';
import * as prompts from '@clack/prompts';
import type { DebugEvent } from '../contracts/debug.js';
import { writeAccentBlock } from './accent-block.js';

function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/\p{Cc}/gu, (character) =>
    character === '\n' ? '\n' : character === '\t' ? '  ' : '',
  );
}

function describe(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return describe(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (value === undefined) return '';
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(
      value,
      (key: string, entry: unknown) => {
        if (
          /^(authorization|cookie|set-cookie|api[-_]?key|password|secret|(?:access|refresh|id)?[-_]?token|encrypted(?:_content)?|signature)$/i.test(
            key,
          )
        )
          return '[redacted]';
        if (/^(base64|image)$/i.test(key) && typeof entry === 'string')
          return '[binary data omitted]';
        if (
          key === 'data' &&
          typeof entry === 'string' &&
          /^[A-Za-z0-9+/]{256,}={0,2}$/.test(entry)
        )
          return '[binary data omitted]';
        if (typeof entry === 'bigint') return entry.toString();
        if (entry instanceof Error)
          return { name: entry.name, message: entry.message };
        if (entry instanceof Uint8Array)
          return `[binary: ${entry.byteLength} bytes]`;
        if (typeof entry === 'object' && entry !== null) {
          if (seen.has(entry)) return '[circular]';
          seen.add(entry);
        }
        return entry;
      },
      2,
    ) ?? ''
  );
}

/** Owns streaming line boundaries, prompt pauses, and terminal-only diagnostics. */
export function createDebugWriter(
  output: Writable & { isTTY?: boolean; columns?: number } = process.stderr,
  secrets: string[] = [],
) {
  const credentials = secrets.filter(Boolean);
  const redact = (text: string) => {
    for (const secret of credentials)
      text = text.replaceAll(secret, '[redacted]');
    return text;
  };
  let active: string | undefined;
  let pending = '';
  let endedWithNewline = true;
  let paused = false;
  let closed = false;
  const queued: DebugEvent[] = [];

  const writeText = (text: string) => {
    const safe = clean(text);
    if (!safe) return;
    output.write(safe);
    endedWithNewline = safe.endsWith('\n');
  };
  const flush = () => {
    if (!active) return;
    writeText(redact(pending));
    pending = '';
    if (!endedWithNewline) output.write('\n');
    active = undefined;
    endedWithNewline = true;
  };
  const block = (title: string, value: unknown) => {
    flush();
    const heading = clean(redact(title)).replace(/\s+/g, ' ').trim();
    const text = clean(redact(describe(value)));
    if (output.isTTY) writeAccentBlock(heading, text, output);
    else output.write(`\n${heading}\n${text ? `${text}\n` : ''}`);
  };
  const write = (event: DebugEvent): void => {
    if (closed) return;
    if (paused) {
      queued.push(event);
      return;
    }
    if (event.kind === 'activity') {
      const activity = event.activity;
      if (activity.kind === 'check')
        block(`Check · ${activity.id} · ${activity.status}`, undefined);
      else if (activity.kind === 'round')
        block(`Round ${activity.round} · ${activity.status}`, activity);
      return;
    }
    if (event.kind === 'detail') {
      block(`${event.agent} · ${event.label}`, event.value);
      return;
    }
    const identity = `${event.agent}:${event.channel}:${event.id}`;
    if (active !== identity) {
      flush();
      const label = {
        text: 'Text',
        reasoning: 'Thinking',
      }[event.channel];
      const heading = clean(`${event.agent} · ${label}`).replace(/\s+/g, ' ');
      output.write('\n');
      if (output.isTTY)
        prompts.log.message(
          styleText(['bold', 'cyan'], heading, { stream: output }),
          {
            output,
            withGuide: false,
          },
        );
      else output.write(`${heading}\n`);
      active = identity;
    }
    pending = redact(pending + event.text);
    // Hold only a possible credential prefix, including keys split across chunks.
    let retained = 0;
    for (const secret of credentials) {
      for (
        let length = 1;
        length < secret.length && length <= pending.length;
        length++
      ) {
        if (pending.endsWith(secret.slice(0, length)))
          retained = Math.max(retained, length);
      }
    }
    writeText(pending.slice(0, pending.length - retained));
    pending = pending.slice(pending.length - retained);
  };

  return {
    write,
    flush,
    pause: () => {
      flush();
      paused = true;
    },
    resume: () => {
      paused = false;
      for (const event of queued.splice(0)) write(event);
    },
    close: () => {
      flush();
      closed = true;
      queued.length = 0;
    },
  };
}
