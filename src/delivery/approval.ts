import type { Ask } from '../contracts/interaction.js';

export async function approve(
  ask: Ask,
  question: string,
  context: string,
  accept: string,
  decline: string,
  signal: AbortSignal,
  contextTitle?: string,
): Promise<boolean> {
  const answer = await ask(
    {
      question,
      context,
      ...(contextTitle === undefined ? {} : { contextTitle }),
      options: [accept, decline],
    },
    signal,
  );
  signal.throwIfAborted();
  return answer === accept;
}
