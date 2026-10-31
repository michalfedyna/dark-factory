import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { factoryConfigSchema } from './schema.js';

export async function loadConfig(filename: string) {
  const path = resolve(filename);
  let data: unknown;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read factory config ${path}. Use factory.config.json as a starting point.`,
      { cause: error },
    );
  }
  const result = factoryConfigSchema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid factory config:\n${details}`);
  }
  return { config: result.data, directory: dirname(path) };
}
