const maxBytes = 10 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const exportHosts = new Set([
  'figma-alpha-api.s3.us-west-2.amazonaws.com',
  'figma-alpha-api.s3-us-west-2.amazonaws.com',
]);

/** Fetch an API-returned export without sending Figma credentials to the CDN. */
export async function downloadFigmaPng(
  source: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const url = new URL(source);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !(url.hostname.endsWith('.figma.com') || exportHosts.has(url.hostname))
  )
    throw new Error('Figma PNG export must use a supported Figma CDN URL.');
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', redirect: 'error', signal });
  } catch {
    signal.throwIfAborted();
    throw new Error('Figma PNG download failed. Export the preview again.');
  }
  signal.throwIfAborted();
  if (!response.ok || !response.body)
    throw new Error(
      'Figma PNG could not be downloaded. Export the preview again.',
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array))
        throw new Error('Expected PNG bytes.');
      length += bytes.byteLength;
      if (length > maxBytes)
        throw new Error('Figma PNG is over 10 MB. Choose a smaller screen.');
      chunks.push(bytes);
    }
  } catch {
    signal.throwIfAborted();
    throw new Error(
      'Figma PNG could not be read or exceeds 10 MB. Choose a smaller screen.',
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const image = Buffer.concat(chunks, length);
  if (!image.subarray(0, pngSignature.length).equals(pngSignature))
    throw new Error('Figma export is not a PNG image.');
  return image.toString('base64');
}
