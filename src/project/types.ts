import type { AuthoringFinding, AuthoringObject, ProjectRef } from '../authoring/types.ts';

export const CHECKPOINTS = [
  'project_contract',
  'code_facts',
  'project_graph',
  'competency_evidence',
  'course_assets',
  'reuse_review',
] as const;

export type CheckpointId = (typeof CHECKPOINTS)[number];
export type CheckpointStatus = 'complete' | 'ready' | 'blocked' | 'pending';
export type AgentKind = 'codex' | 'claude' | 'manual';
export type DocumentPrivacy = 'private_local' | 'public_remote';

export interface ProjectDocument {
  id: string;
  locator: string;
  kind: 'local' | 'remote';
  privacy: DocumentPrivacy;
  sha256: string;
  bytes: number;
  local_copy?: string;
}

export interface ProjectInput {
  spec_version: 'ptkg-project-input@1';
  workspace_id: string;
  status: 'candidate' | 'unresolved';
  repository: {
    locator: string;
    kind: 'local' | 'remote';
    requested_ref: string | null;
    commit: string;
    tree: string;
  };
  goal: string | null;
  curriculum_boundary: 'pre_project_readiness';
  documents: ProjectDocument[];
  unresolved_questions: string[];
}

export interface GitSnapshot {
  projectRef: ProjectRef;
  tree: string;
  createdAt: string;
  repositoryKind: 'local' | 'remote';
  repositoryLocator: string;
  requestedRef: string | null;
  gitDir: string;
  sourceRoot: string;
}

export interface AnalyzerContext {
  runId: string;
  projectRef: ProjectRef;
  commit: string;
  createdAt: string;
  listFiles(): Promise<string[]>;
  readFile(file: string): Promise<string>;
}

export interface AnalyzerResult {
  analyzer: string;
  capability: 'symbol' | 'file';
  facts: AuthoringObject[];
  warnings: string[];
}

export interface SourceAnalyzer {
  readonly id: string;
  analyze(context: AnalyzerContext): Promise<AnalyzerResult>;
}

export interface CheckpointState {
  id: CheckpointId;
  status: CheckpointStatus;
  evidence: string[];
  blockers: string[];
}

export interface ProjectWorkspaceStatus {
  workspace: string;
  project_ref: ProjectRef | null;
  source_locked: boolean;
  next_checkpoint: CheckpointId | null;
  checkpoints: CheckpointState[];
  findings: AuthoringFinding[];
  unresolved_questions: string[];
  next_command: string | null;
  parallel_authoring: {
    checkpoint: CheckpointId;
    input_hash: string;
    merged: boolean;
    shard_count: number;
    ready_shards: number;
    pending_shard_ids: string[];
    invalid_shard_ids: string[];
  } | null;
}

export interface ProjectInitOptions {
  repository: string;
  goal?: string;
  documents?: string[];
  ref?: string;
  cacheDir?: string;
}

export interface ProjectInitResult {
  input: ProjectInput;
  snapshot: GitSnapshot;
  analyzerResults: AnalyzerResult[];
  status: ProjectWorkspaceStatus;
}

export interface AuthorResult {
  agent: AgentKind;
  checkpoint: CheckpointId | null;
  instruction_path: string | null;
  log_path: string | null;
  exit_code: number;
  status: ProjectWorkspaceStatus;
}
