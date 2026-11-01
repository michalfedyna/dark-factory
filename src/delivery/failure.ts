/** Only controller-authored messages are safe to print outside private artifacts. */
export class DeliveryStepFailure extends Error {
  constructor(step: string, path: string | undefined, cause: unknown) {
    super(
      `Workflow failed at ${step}. ` +
        (path ? `See ${path}. ` : 'Failure diagnostics could not be saved. ') +
        'No failed gate authorizes publication.',
      { cause },
    );
  }
}

interface FailureDetails {
  name?: string;
  message: string;
  cause?: FailureDetails;
}

export function failureDetails(error: unknown, depth = 0): FailureDetails {
  if (!(error instanceof Error))
    return { message: typeof error === 'string' ? error : 'Unknown failure.' };
  return {
    name: error.name,
    message: error.message,
    ...(error.cause !== undefined && depth < 5
      ? { cause: failureDetails(error.cause, depth + 1) }
      : {}),
  };
}
