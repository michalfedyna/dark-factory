import { createAgentBrowserTool } from './agent-browser.js';
import { createAgentDeviceTool } from './agent-device.js';
import type { QaToolOptions } from './qa-command.js';

/** Assemble only the integrations required by the configured targets. */
export function createQaTools(options: QaToolOptions) {
  return {
    ...(options.project.targets.some((target) => target.kind === 'web')
      ? { agent_browser: createAgentBrowserTool(options) }
      : {}),
    ...(options.project.targets.some((target) => target.kind === 'mobile')
      ? { agent_device: createAgentDeviceTool(options) }
      : {}),
  };
}
