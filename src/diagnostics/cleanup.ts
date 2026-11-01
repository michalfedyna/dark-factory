/** Always clean up, but never replace an existing failure or cancellation. */
export async function withCleanup<T>(
  work: () => Promise<T>,
  cleanup: () => void | Promise<void>,
  report: (error: unknown) => void | Promise<void>,
): Promise<T> {
  const close = async () => {
    try {
      await cleanup();
    } catch (error) {
      try {
        await report(error);
      } catch {
        // Reporting must not hide either the primary failure or cleanup failure.
      }
      throw error;
    }
  };
  let result: T;
  try {
    result = await work();
  } catch (error) {
    try {
      await close();
    } catch {
      // Cleanup has been reported; the work's failure remains authoritative.
    }
    throw error;
  }
  await close();
  return result;
}

/** Try every owned resource, then expose all cleanup failures to its owner. */
export async function cleanupAll(
  actions: (() => void | Promise<void>)[],
): Promise<void> {
  const results = await Promise.allSettled(
    actions.map(async (action) => action()),
  );
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, 'Resource cleanup failed.');
}
