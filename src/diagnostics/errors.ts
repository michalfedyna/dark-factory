const maxText = 16_000;

export interface ErrorDetails {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
  command?: string;
  args?: string[];
  stdout?: string;
  stderr?: string;
  cause?: ErrorDetails;
  errors?: ErrorDetails[];
}

/** Keep useful, bounded error details in private diagnostics, never public copy. */
export function errorDetails(error: unknown, depth = 0): ErrorDetails {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('message' in error) ||
    typeof error.message !== 'string'
  )
    return {
      message:
        typeof error === 'string'
          ? error.slice(0, maxText)
          : 'Unknown failure.',
    };
  const details: ErrorDetails = {
    message: error.message.slice(0, maxText),
  };
  for (const key of ['name', 'stack'] as const) {
    const value: unknown = Reflect.get(error, key);
    if (typeof value === 'string') details[key] = value.slice(0, maxText);
  }
  if (
    'code' in error &&
    (typeof error.code === 'string' || typeof error.code === 'number')
  )
    details.code = error.code;
  for (const key of ['command', 'stdout', 'stderr'] as const) {
    const value: unknown = Reflect.get(error, key);
    if (typeof value === 'string') details[key] = value.slice(-maxText);
  }
  if ('args' in error && Array.isArray(error.args))
    details.args = error.args
      .filter((arg): arg is string => typeof arg === 'string')
      .slice(0, 100)
      .map((arg) => arg.slice(0, 8_000));
  if (depth < 5) {
    if ('cause' in error && error.cause !== undefined)
      details.cause = errorDetails(error.cause, depth + 1);
    if ('errors' in error && Array.isArray(error.errors))
      details.errors = (error.errors as unknown[])
        .slice(0, 20)
        .map((cause) => errorDetails(cause, depth + 1));
  }
  return details;
}
