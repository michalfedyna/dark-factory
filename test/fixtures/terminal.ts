import { PassThrough } from 'node:stream';
import { WriteStream } from 'node:tty';

export function captureTerminalOutput(isTTY = true, columns?: number) {
  const output = Object.assign(new PassThrough(), {
    isTTY,
    getColorDepth: () => WriteStream.prototype.getColorDepth(),
    ...(columns === undefined ? {} : { columns }),
  });
  let log = '';
  output.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  return { output, log: () => log };
}
