import type { CheckpointId } from './types.ts';

export const PARALLEL_CHECKPOINTS = ['competency_evidence', 'course_assets'] as const satisfies readonly CheckpointId[];
export type ParallelCheckpointId = (typeof PARALLEL_CHECKPOINTS)[number];

export const SHARD_MERGE_JSONL_PATHS = [
  '04-behaviors/behavior-chains.jsonl',
  '05-slices/learning-slices.jsonl',
  '07-projection/nodes.jsonl',
  '07-projection/edges.jsonl',
  '07-projection/sources.jsonl',
  '09-course/units.jsonl',
  '09-course/questions.jsonl',
  '09-course/practices.jsonl',
  '09-course/gates.jsonl',
] as const;

export type ShardMergeJsonlPath = (typeof SHARD_MERGE_JSONL_PATHS)[number];

export interface AgentShardManifest {
  spec_version: 'ptkg-agent-shard@1';
  shard_id: string;
  workspace_id: string;
  checkpoint: ParallelCheckpointId;
  input_hash: string;
  source: {
    commit: string;
    tree: string;
  };
  scope_kind: 'coverage_unit' | 'course_unit';
  scope_ids: string[];
  output_root: 'agent-workspace/output';
  allowed_jsonl_paths: ShardMergeJsonlPath[];
  allowed_card_glob: '09-course/cards/*.md' | null;
  status: 'candidate' | 'unresolved';
  created_at: string;
}

export interface AgentTaskPlan {
  spec_version: 'ptkg-agent-task-plan@1';
  workspace_id: string;
  checkpoint: ParallelCheckpointId;
  input_hash: string;
  source: { commit: string; tree: string };
  shards: Array<{
    shard_id: string;
    scope_kind: 'coverage_unit' | 'course_unit';
    scope_ids: string[];
    manifest_hash: string;
  }>;
  state: 'active' | 'merged';
  created_at: string;
}

export type ShardMergeDisposition = 'accepted' | 'duplicate' | 'conflict' | 'stale' | 'rejected';

export interface ShardMergeItem {
  shard_id: string;
  path: string;
  object_id?: string;
  disposition: ShardMergeDisposition;
  reason: string;
  canonical_hash?: string;
  shard_hash?: string;
}

export interface ShardMergeReport {
  spec_version: 'ptkg-agent-merge-report@1';
  workspace_id: string;
  input_hash: string;
  dry_run: boolean;
  applied: boolean;
  shard_ids: string[];
  summary: Record<ShardMergeDisposition, number>;
  items: ShardMergeItem[];
  written_paths: string[];
  sealed_shards: Array<{ shard_id: string; manifest_hash: string; output_hash: string }>;
}
