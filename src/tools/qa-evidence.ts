import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { EvidenceRecorder } from '../delivery/evidence.js';

/** Expose controller-recorded observations without letting the agent author evidence. */
export function createQaEvidenceTool(evidence: EvidenceRecorder) {
  return createTool({
    id: 'qa_evidence',
    description:
      'List sandbox QA command evidence recorded in this session. Use these IDs in criterion results and findings.',
    inputSchema: z.strictObject({}),
    execute: () =>
      Promise.resolve(
        evidence.records
          .filter((record) => record.kind === 'sandbox')
          .map(({ id, operation, exitCode, path }) => ({
            id,
            operation,
            exitCode,
            path,
          })),
      ),
  });
}
