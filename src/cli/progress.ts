import type { Writable } from 'node:stream';
import { spinner } from '@clack/prompts';

export function createProgressSpinner(
  output: Writable & { isTTY?: boolean } = process.stderr,
) {
  const animation = output.isTTY
    ? spinner({ output, withGuide: false })
    : undefined;
  let running = false;
  let closed = false;

  const clear = () => {
    if (!running) return;
    animation?.clear();
    running = false;
  };

  return {
    start: (message: string) => {
      if (!animation || closed) return;
      // Clack starts a new timer on every start(), even while already running.
      if (running) {
        animation.message(message);
      } else {
        animation.start(message);
        running = true;
      }
    },
    clear,
    close: () => {
      closed = true;
      clear();
    },
  };
}
