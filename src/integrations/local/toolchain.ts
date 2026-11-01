import { stat } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

/** Pass tool locations, not the host's credentials or mutable home directory. */
export async function toolchainEnvironment(
  host: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<NodeJS.ProcessEnv> {
  const fallbackLocale = platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  const utf8 = (value: string | undefined) =>
    value && /utf-?8/i.test(value) ? value : undefined;
  const locale = utf8(host.LC_ALL) ?? utf8(host.LANG) ?? fallbackLocale;
  const env: NodeJS.ProcessEnv = { LANG: locale, LC_ALL: locale };
  for (const key of ['JAVA_HOME', 'DEVELOPER_DIR'] as const)
    if (host[key]) env[key] = host[key];

  let androidSdk = host.ANDROID_HOME || host.ANDROID_SDK_ROOT;
  if (!androidSdk && host.HOME) {
    const location =
      platform === 'darwin'
        ? join(host.HOME, 'Library', 'Android', 'sdk')
        : join(host.HOME, 'Android', 'Sdk');
    if (
      await stat(location).then(
        (entry) => entry.isDirectory(),
        () => false,
      )
    )
      androidSdk = location;
  }
  if (androidSdk) {
    env.ANDROID_HOME = androidSdk;
    env.ANDROID_SDK_ROOT = androidSdk;
  }
  env.PATH = [
    dirname(process.execPath),
    ...(env.JAVA_HOME ? [join(env.JAVA_HOME, 'bin')] : []),
    ...(androidSdk
      ? [join(androidSdk, 'platform-tools'), join(androidSdk, 'emulator')]
      : []),
    host.PATH,
  ]
    .filter(Boolean)
    .join(delimiter);
  return env;
}
