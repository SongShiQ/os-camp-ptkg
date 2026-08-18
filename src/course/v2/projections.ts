import { canonicalJson, sha256 } from '../io.ts';
import type {
  AssertionDefinitionV1,
  CourseManifestV2,
  GatePolicyV1,
  KnowledgeForestProjectionV1,
  PracticeDefinitionProjectionV1,
  PracticeDefinitionV2,
  RemediationV1,
  SourceBridgeV1,
  TeacherReviewItemV1,
  TeacherReviewProjectionV1,
} from './types.ts';
import type { PtkgEdge, PtkgNode } from '../../types.ts';
import type { CourseStage, CourseUnit } from '../types.ts';

function byId<T extends { id: string }>(values: T[]): T[] {
  return [...values].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildKnowledgeForestProjection(input: {
  manifest: CourseManifestV2;
  publicPackageRoot?: string | null;
  nodes: PtkgNode[];
  edges: PtkgEdge[];
  stages: CourseStage[];
  units: CourseUnit[];
}): KnowledgeForestProjectionV1 {
  const unitByNode = new Map<string, CourseUnit>();
  for (const unit of byId(input.units)) {
    for (const nodeId of unit.node_ids) if (!unitByNode.has(nodeId)) unitByNode.set(nodeId, unit);
  }
  const stageById = new Map(input.stages.map((stage) => [stage.id, stage]));
  return {
    contract: 'knowledge-forest-projection@1',
    course_id: input.manifest.course_id,
    version: input.manifest.version,
    public_package_root: input.publicPackageRoot ?? null,
    default_collapse_depth: 2,
    nodes: byId(input.nodes).map((node) => {
      const unit = unitByNode.get(node.id);
      return {
        id: node.id,
        type: node.type,
        stage_layer: unit ? (stageById.get(unit.stage_id)?.layer ?? null) : null,
        dependency_depth: unit?.dependency_depth ?? 0,
        origin_projects: [...(unit?.origin_projects ?? [])].sort(),
        reuse_count: unit?.reuse_count ?? 0,
        source_ids: [...(node.source_ids ?? [])].sort(),
        flags: [
          ...(node.status === 'unresolved' || node.status === 'stale' ? ['unresolved' as const] : []),
          ...(node.status === 'stale' ? ['expired' as const] : []),
          ...(node.tags?.includes('conflict') ? ['conflict' as const] : []),
        ],
      };
    }),
    edges: byId(input.edges).map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      relation: edge.type,
    })),
  };
}

export function buildPracticeDefinitionProjection(input: {
  manifest: CourseManifestV2;
  practices: PracticeDefinitionV2[];
  assertions: AssertionDefinitionV1[];
  remediations: RemediationV1[];
  gates: GatePolicyV1[];
}): PracticeDefinitionProjectionV1 {
  return {
    contract: 'practice-definition-projection@1',
    course_id: input.manifest.course_id,
    version: input.manifest.version,
    practices: byId(input.practices),
    assertions: byId(input.assertions.filter((item) => item.visibility === 'public')),
    remediations: byId(input.remediations),
    gates: byId(input.gates),
  };
}

function reviewQueue(item: { status: string }, highRisk: boolean): TeacherReviewItemV1['queue'] {
  if (highRisk || item.status === 'unresolved') return 'conflict_high_impact';
  return 'behavior_slice_evidence';
}

export function buildTeacherReviewProjection(input: {
  manifest: CourseManifestV2;
  practices: PracticeDefinitionV2[];
  assertions: AssertionDefinitionV1[];
  bridges: SourceBridgeV1[];
  metadataCandidates?: Array<{ id: string; content_hash: string; reasons: string[] }>;
}): TeacherReviewProjectionV1 {
  const items: TeacherReviewItemV1[] = [];
  for (const practice of input.practices) {
    if (practice.status === 'reviewed') continue;
    items.push({
      id: `review.practice.${practice.id}`,
      queue: reviewQueue(practice, practice.governance.risk === 'high'),
      object_ref: practice.id,
      object_hash: practice.content_hash,
      reasons: practice.governance.risk === 'high'
        ? ['高风险实践需要教师审核行为、切片、证据与隐藏材料边界']
        : ['实践尚未完成教师审核'],
    });
  }
  for (const assertion of input.assertions) {
    if (assertion.status === 'reviewed') continue;
    items.push({
      id: `review.assertion.${assertion.id}`,
      queue: reviewQueue(assertion, assertion.visibility === 'teacher_private' || assertion.assertion_class === 'fault_probe'),
      object_ref: assertion.id,
      object_hash: assertion.content_hash,
      reasons: ['typed assertion 的 oracle、producer 与可见性尚未完成教师审核'],
    });
  }
  for (const bridge of input.bridges) {
    if (bridge.status === 'reviewed') continue;
    items.push({
      id: `review.bridge.${bridge.id}`,
      queue: 'conflict_high_impact',
      object_ref: bridge.id,
      object_hash: bridge.content_hash,
      reasons: ['跨源码桥接及证据失效边界必须高风险审核'],
    });
  }
  for (const candidate of input.metadataCandidates ?? []) {
    items.push({
      id: `review.metadata.${candidate.id}`,
      queue: 'low_risk_metadata',
      object_ref: candidate.id,
      object_hash: candidate.content_hash,
      reasons: candidate.reasons,
    });
  }
  return {
    contract: 'teacher-review-projection@1',
    course_id: input.manifest.course_id,
    version: input.manifest.version,
    items: byId(items),
  };
}

export function projectionHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
