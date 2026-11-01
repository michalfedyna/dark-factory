import { createAgentBrowserTool } from './agent-browser.js';
import { createAgentDeviceTool } from './agent-device.js';
import type { QaToolOptions } from './qa-command.js';
import { createQaReferenceTool } from './qa-reference.js';
import type { QaReference } from '../delivery/qa-references.js';

/** Assemble only the integrations required by the configured targets. */
export function createQaTools(
  options: QaToolOptions & { references?: QaReference[] },
) {
  return {
    ...(options.references?.length
      ? {
          qa_reference: createQaReferenceTool(
            options.references,
            options.signal,
          ),
        }
      : {}),
    ...(options.project.targets.some((target) => target.kind === 'web')
      ? { agent_browser: createAgentBrowserTool(options) }
      : {}),
    ...(options.project.targets.some((target) => target.kind === 'mobile')
      ? { agent_device: createAgentDeviceTool(options) }
      : {}),
  };
}
