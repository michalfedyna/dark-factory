import type {
  LocalFilesystem,
  LocalSandbox,
  Workspace,
} from '@mastra/core/workspace';
import type { FactoryConfig } from '../config/schema.js';
import type { Project, VerificationProject } from '../contracts/project.js';
import type { Observe } from '../contracts/progress.js';
import type { RunRepository } from '../integrations/git/repository.js';
import type { inspectRepository } from '../integrations/git/inspect.js';
import type { createRunArtifacts } from './artifacts.js';
import type { EvidenceRecorder } from './evidence.js';

export interface DeliveryOptions {
  repository: Awaited<ReturnType<typeof inspectRepository>>;
  model: FactoryConfig['model'];
  sandbox: FactoryConfig['sandbox'];
  apiKey: string;
  runId: string;
  signal: AbortSignal;
  progress: (message: string) => void;
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
  assertRunning: () => Promise<void>;
  close: () => Promise<void>;
}

export interface RoundResources {
  round: number;
  revision: string;
  project: VerificationProject;
  evidence: EvidenceRecorder;
  qaSession: QaSession;
}
