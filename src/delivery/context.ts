import type {
  LocalFilesystem,
  LocalSandbox,
  Workspace,
} from '@mastra/core/workspace';
import type { FactoryConfig } from '../config/schema.js';
import type { IssueBrief } from '../contracts/issue.js';
import type { Project, ProjectInspection } from '../contracts/project.js';
import type { Observe } from '../contracts/progress.js';
import type { RunRepository } from '../integrations/git/repository.js';
import type { createRunArtifacts } from './artifacts.js';
import type { EvidenceRecorder } from './evidence.js';

export interface DeliveryOptions {
  inspect: (
    brief: IssueBrief,
    signal: AbortSignal,
  ) => Promise<ProjectInspection>;
  model: FactoryConfig['model'];
  apiKey: string;
  runId: string;
  signal: AbortSignal;
  progress: (message: string) => void;
  diagnostic?: (message: string) => void;
  observe?: Observe;
}

// Live, run-owned resources never enter DeliveryState or workflow output.
export interface RunResources {
  runId: string;
  project: Project;
  directory: string;
  artifacts: ReturnType<typeof createRunArtifacts>;
  repository: RunRepository;
  implementationWorkspace: Workspace;
  implementationSandbox: LocalSandbox;
  verificationWorkspace: Workspace;
  verificationFiles: LocalFilesystem;
  projectSandbox: LocalSandbox;
  automationSandbox: LocalSandbox;
  browserConfig: string;
}

export interface QaSession {
  start: (signal: AbortSignal) => Promise<void>;
  assertRunning: () => void;
  close: () => Promise<void>;
}

export interface RoundResources {
  round: number;
  revision: string;
  evidence: EvidenceRecorder;
  qaSession: QaSession;
}
