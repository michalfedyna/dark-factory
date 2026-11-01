/** Only controller-authored messages are safe to print outside private artifacts. */
export class DeliveryStepFailure extends Error {
  constructor(step: string, path: string | undefined, cause: unknown) {
    super(
      (step === 'explore-issue'
        ? 'Exploration failed or returned an invalid brief. '
        : `Workflow failed at ${step}. `) +
        (path ? `See ${path}. ` : 'Failure diagnostics could not be saved. ') +
        'No failed gate authorizes publication.',
      { cause },
    );
  }
}
