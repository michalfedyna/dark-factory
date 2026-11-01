import { Agent } from '@mastra/core/agent';
import type { Workspace } from '@mastra/core/workspace';
import type { FactoryConfig } from '../config/schema.js';
import type { FigmaResult, FigmaSource } from '../contracts/figma.js';
import { implementationSchema } from '../contracts/delivery.js';
import type { Project, VerificationPlan } from '../contracts/project.js';
import { createModelConfig } from './model.js';
import { createDocumentation } from './documentation.js';
import {
  deliveryInstructions,
  dependencyInstructions,
  generateDeliveryResult,
  type DeliveryAgentInput,
} from './shared.js';
import type { IssueTask, RepairFinding } from './task.js';

const instructions = `${deliveryInstructions}

${dependencyInstructions}

Implement the supplied task with focused source changes and tests. Read the repository instructions and relevant files first.
You own implementation, not approval. Use the workspace filesystem and sandbox tools.

Repository setup:
- Inspect the pinned checkout and choose implementation details within the approved scope. Install dependencies and scaffold the app when needed.
- An empty repository or missing manifest, lockfile, scripts, or source is implementation work, not a blocker or a request for the user to scaffold it.
- Preserve existing conventions. For a new app, create its manifest, lockfile, runnable development and meaningful verification scripts. Ignore dependency/build outputs before handing off.
- Finish source-generating setup before returning the candidate. If the verification path needs an Expo native build, run prebuild during implementation and align package scripts with expo run:ios/run:android so later preparation does not rewrite package.json. Do not require prebuild for a browser or supported existing runtime path. Decide which native files are source and which are ignored generated output.

Verification handoff:
- Return verification for this candidate: at least one meaningful deterministic check and enough runnable targets to cover the approved behavior and explicit platform requirements. Prefer an available browser or simulator over unnecessary native build prerequisites for shared behavior.
- Use actual commands and app identifiers from the project you implemented, not no-op checks or an unrelated server/app. Commands run at the repository root; use directory options for nested apps.
- Web targets need strict-port start commands and matching URLs. Native targets need preparation commands that make this candidate available in the selected app/runtime; build and install when needed, not merely to enforce a toolchain version. Require screenshots unless inappropriate; omit targets only for non-UI work.
- Prefer serving the checked production build for web QA. Native isolation is optional; when enabled, use compatible start commands (for example, Turbopack's macOS FSEvents watcher may be unavailable). Do not change the factory's execution policy to work around a failed server.
- The controller captures the candidate, then runs checks and starts QA targets independently. Return an updated plan on every successful repair.
- Checks and native preparation must preserve captured source, tests, manifests, and lockfiles. A setup mutation invalidates the attempt and returns to implementation; it never authorizes QA or publication.
- Discover installed targets before reporting missing infrastructure: use emulator -list-avds, adb devices, and xcrun simctl list devices available as applicable. An empty adb list only means no device is attached or booted; installed simulators/AVDs can be booted by the preparation/device tooling. Use ANDROID_AVD_HOME for host AVD discovery despite the private HOME; use emulator -read-only when booting a host AVD and keep writable emulator state in the private run home. Stop processes you start; do not shut down pre-existing user devices.
- Attempt the chosen verification path before declaring a toolchain blocker. Prefer an already-installed compatible JDK (including Android Studio's bundled JDK) or in-scope project compatibility fixes after an actual build failure. A missing legacy Simulator.app is not a blocker when simctl/device tooling works. Do not install host-wide tools with Homebrew, sudo, or system package managers, weaken meaningful checks, or remove explicitly required targets. Report an observed missing prerequisite only when it prevents required verification with no suitable alternative.
- Independent browser/device QA and screenshots belong to the later QA stage. Do not run them here or treat pending QA as an implementation blocker. Report any local verification limitation in the summary without claiming a pass.
- Use blockers only for issues that prevent implementation or a usable verification handoff. A blocked result may include a known verification plan; use null when no valid plan can be supplied. Any blocker stops the workflow, even when verification is present.

Boundaries and repairs:
- When a figma handoff is supplied, the UI agent has already scaffolded presentation in this checkout. Read its component interfaces, tokens and implementationNotes; preserve design fidelity and reuse that scaffold. Replace sample content and wire behavior, data, routing, state and integrations. Do not rebuild the UI from scratch. You own subsequent functional and UI repairs, within the approved scope.
- Do not run Git, publish, modify factory artifacts, or inspect unrelated host files. Keep source changes inside this run's repository and allowedPaths. Host toolchain and simulator discovery is allowed, not permission to modify host installations or read host credentials.
- When repair feedback is supplied, address its findings, failed criterion notes, and failed check logs. QA and review will independently recheck the entire new candidate.
- Assumptions are unverified, not requirements. Report a blocker if a necessary assumption cannot be established.
- Do not disable tests to pass a gate.
- Keep background servers out of this stage; configured verification commands start them later.
- Work is supervised. Do not set command execution timeouts; let commands finish and respect cancellation.
- If the approved scope cannot solve a finding, return a blocker instead of expanding scope.
- Summarize the complete task implementation in the current candidate, not only the latest repair. Do not claim verification that you did not run.`;

export interface FailedCheckLog {
  checkId: string;
  exitCode: number;
  excerpt: string;
}

export interface ImplementationContext {
  task: IssueTask;
  allowedPaths: Project['allowedPaths'];
  checks: VerificationPlan['checks'];
  figma?: { sources: FigmaSource[]; result: FigmaResult };
  repair: {
    findings: RepairFinding[];
    failedCriteria: { id: string; notes: string }[];
    checkLogs: FailedCheckLog[];
  } | null;
}

export function createImplementation(
  model: FactoryConfig['model'],
  apiKey: string,
) {
  return (
    input: DeliveryAgentInput<ImplementationContext> & { workspace: Workspace },
  ) => {
    const modelConfig = createModelConfig(model, apiKey);
    const agent = new Agent({
      id: 'implementation',
      name: 'Delivery implementation',
      instructions,
      ...modelConfig,
      agents: {
        documentation: createDocumentation(model, apiKey, input.observe),
      },
      defaultOptions: {
        ...modelConfig.defaultOptions,
        // Library research needs only the focused delegation prompt.
        delegation: { messageFilter: () => [], hookErrorStrategy: 'throw' },
      },
      workspace: input.workspace,
    });
    return generateDeliveryResult(agent, implementationSchema, input);
  };
}
