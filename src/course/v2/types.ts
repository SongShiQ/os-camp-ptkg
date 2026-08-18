import type {
  CourseCard,
  CourseGenerator,
  CourseQuestion,
  CourseReviewStatus,
  CourseStage,
  CourseStageLayer,
  CourseUnit,
} from '../types.ts';
import type { PtkgEdge, PtkgNode, PtkgSource } from '../../types.ts';

export type Sha256 = string;
export type GitOid = string;

export type SourceContinuity =
  | 'exact'
  | 'same_repo_new_ref'
  | 'patch_overlay'
  | 'high_fidelity_fixture'
  | 'reference_only';

export type PracticeProfile = 'observe' | 'trace' | 'fill' | 'debug' | 'test' | 'review';
export type RunPurpose = 'release_validation' | 'student_attempt';
export type EvidencePurpose = 'release' | 'attempt' | 'mastery';
export type AssertionClass = 'positive' | 'negative' | 'concurrency' | 'regression' | 'fault_probe';
export type AssertionStatus =
  | 'passed'
  | 'failed'
  | 'not_run'
  | 'not_applicable'
  | 'infrastructure_error';

export interface SourceIdentityV1 {
  source_contract_id: string;
  source_contract_root: Sha256;
  repo: string;
  commit: GitOid;
  tree: GitOid;
}

export interface SourceAnchorV1 {
  anchor_id: string;
  path: string;
  blob_oid: GitOid;
  symbol: string | null;
  start_line: number | null;
  end_line: number | null;
  snippet_hash: Sha256;
}

export interface ChangeScopeV1 {
  kind: 'file' | 'symbol' | 'range' | 'glob';
  path: string;
  symbol?: string;
  start_line?: number;
  end_line?: number;
}

export interface AssertionOracleV1 {
  type: 'exit_code' | 'structured_event' | 'file_state' | 'process_state' | 'custom_harness';
  observable: string;
  expected: string;
  evidence_source: 'trusted_harness' | 'worker_observation' | 'host_inspection';
}

export interface AssertionDefinitionV1 {
  spec_version: 'assertion-definition@1';
  id: string;
  practice_id: string;
  assertion_class: AssertionClass;
  behavior: string;
  invariant: string;
  oracle: AssertionOracleV1;
  applicable_to: RunPurpose[];
  trusted_producers: string[];
  visibility: 'public' | 'teacher_private';
  harness_id: string | null;
  not_applicable_reason: string | null;
  status: CourseReviewStatus;
  content_hash: Sha256;
}

export interface PracticeHintRuleV1 {
  level: 1 | 2 | 3;
  text: string;
  requires_attempt_count: number;
  requires_failed_assertion_ids: string[];
}

export interface PracticeDefinitionV2 {
  spec_version: 'practice-definition@2';
  id: string;
  course_version: string;
  unit_ids: string[];
  behavior_ids: string[];
  slice_ids: string[];
  source: SourceIdentityV1;
  source_anchors: SourceAnchorV1[];
  source_continuity: SourceContinuity;
  profile: PracticeProfile;
  title: string;
  student_responsibilities: string[];
  provided_scaffolding: string[];
  hidden_material_ids: string[];
  change_policy: {
    mode: 'read_only' | 'structured_diff';
    allowed: ChangeScopeV1[];
    forbidden: ChangeScopeV1[];
  };
  assertion_ids: string[];
  execution: {
    trusted_commands: string[];
    environment_digest: string;
    harness_ids: string[];
    timeout_seconds: number;
    memory_mb: number;
    processes: number;
    reset_required: boolean;
  };
  pedagogy: {
    prediction: 'none' | 'optional' | 'required';
    hints: PracticeHintRuleV1[];
    remediation_ids: string[];
  };
  governance: {
    risk: 'low' | 'medium' | 'high';
    audience: 'student' | 'teacher';
    visibility: 'public' | 'restricted';
    requires_teacher_overlay: boolean;
    review_event_ids: string[];
  };
  status: CourseReviewStatus;
  generated_by: CourseGenerator;
  content_hash: Sha256;
}

export interface ResetEvidenceV1 {
  status: 'succeeded' | 'failed' | 'not_required';
  log_hash: Sha256 | null;
}

export interface AssertionResultV1 {
  spec_version: 'assertion-result@1';
  id: string;
  attempt_id: string;
  run_purpose: RunPurpose;
  practice_id: string;
  practice_hash: Sha256;
  assertion_id: string;
  assertion_hash: Sha256;
  release_set_root: Sha256;
  public_package_root: Sha256;
  teacher_overlay_root: Sha256 | null;
  source_contract_root: Sha256;
  source_commit: GitOid;
  source_tree: GitOid;
  student_diff_hash: Sha256 | null;
  patch_hash: Sha256 | null;
  image_digest: string;
  environment_hash: Sha256;
  harness_hash: Sha256;
  test_hash: Sha256;
  status: AssertionStatus;
  failure_category:
    | 'student_error'
    | 'test_failure'
    | 'toolchain_failure'
    | 'worker_failure'
    | null;
  artifact_hashes: Sha256[];
  reset: ResetEvidenceV1;
  created_at: string;
  content_hash: Sha256;
}

export interface EvidenceEnvelopeV1 {
  spec_version: 'evidence-envelope@1';
  id: string;
  purpose: EvidencePurpose;
  producer: string;
  authority: 'trusted_worker' | 'teacher' | 'student' | 'deterministic_grader';
  trust_root: Sha256;
  course_id: string;
  course_version: string;
  /**
   * 发布前收据先进入公开包，此时最终 public/release roots 尚不存在，二者为 null；
   * 签名 Release Set 随后把该收据连同公开包一起提交。attempt/mastery 必须非 null。
   */
  release_set_root: Sha256 | null;
  public_package_root: Sha256 | null;
  teacher_overlay_root: Sha256 | null;
  source: SourceIdentityV1;
  practice_id: string;
  practice_hash: Sha256;
  assertion_ids: string[];
  object_hashes: Sha256[];
  status: 'accepted' | 'rejected' | 'pending' | 'infrastructure_error';
  artifact_hashes: Sha256[];
  invalidated_by: string[];
  expires_at: string | null;
  created_at: string;
  content_hash: Sha256;
}

export interface GatePolicyV1 {
  spec_version: 'gate-policy@1';
  id: string;
  stage_id: string;
  unit_ids: string[];
  prerequisite_gate_ids: string[];
  required_assertion_ids: string[];
  allowed_evidence_purposes: EvidencePurpose[];
  allowed_producers: string[];
  trusted_roots: Sha256[];
  max_age_seconds: number | null;
  decision: 'deterministic' | 'teacher_final';
  status: CourseReviewStatus;
  generated_by: CourseGenerator;
  content_hash: Sha256;
}

export interface RemediationV1 {
  spec_version: 'remediation@1';
  id: string;
  practice_id: string;
  assertion_ids: string[];
  knowledge_node_ids: string[];
  card_ids: string[];
  retry_practice_id: string;
  status: CourseReviewStatus;
  content_hash: Sha256;
}

export interface PublicReviewEventSummaryV1 {
  spec_version: 'public-review-event-summary@1';
  event_id: string;
  object_ref: string;
  object_hash: Sha256;
  action: 'accept' | 'publish' | 'revoke';
  actor_id: string;
  created_at: string;
}

export interface SourceBridgeBindingV1 {
  binding_id: string;
  anchor_ids: string[];
}

export interface SourceBridgeV1 {
  spec_version: 'source-bridge@1';
  id: string;
  from_source_contract_root: Sha256;
  to_source_contract_root: Sha256;
  canonical_capability_id: string;
  from_binding_and_anchors: SourceBridgeBindingV1[];
  to_binding_and_anchors: SourceBridgeBindingV1[];
  behavior_relation: 'equivalent' | 'partial' | 'divergent' | 'unresolved';
  known_differences: string[];
  inheritable_evidence_kinds: Array<'conceptual_prerequisite'>;
  forbidden_inheritance: Array<'execution' | 'navigation' | 'diff' | 'runtime'>;
  migration_practice_id: string;
  review_event_id: string | null;
  status: CourseReviewStatus;
  content_hash: Sha256;
}

export interface CompositionWorkspaceV1 {
  id: string;
  workspace_root_hash: Sha256;
  projection_root: Sha256;
  source_contract_id: string;
  source_contract_root: Sha256;
}

export interface SourceCompositionManifestV1 {
  spec_version: 'composition-manifest@1';
  id: string;
  workspaces: CompositionWorkspaceV1[];
  bridge_ids: string[];
  status: CourseReviewStatus;
  content_hash: Sha256;
}

export interface CourseManifestV2 {
  contract: 'os-camp-course@2';
  course_id: string;
  version: string;
  title: string;
  language: string;
  package_status: 'draft' | 'release';
  curriculum_boundary: 'pre_project_readiness';
  source_composition_root: Sha256;
  source_contract_ids: string[];
  source_bridge_ids: string[];
  generator: CourseGenerator;
}

export interface CourseChecksumsV2 {
  contract: 'os-camp-course-checksums@2';
  algorithm: 'sha256';
  files: Array<{ path: string; sha256: Sha256; bytes: number }>;
  root_hash: Sha256;
}

export interface CourseStageV2 extends Omit<CourseStage, 'layer'> {
  layer: CourseStageLayer;
}

export interface KnowledgeForestProjectionV1 {
  contract: 'knowledge-forest-projection@1';
  course_id: string;
  version: string;
  public_package_root: Sha256 | null;
  default_collapse_depth: number;
  nodes: Array<{
    id: string;
    type: string;
    stage_layer: CourseStageLayer | null;
    dependency_depth: number;
    origin_projects: string[];
    reuse_count: number;
    source_ids: string[];
    flags: Array<'unresolved' | 'conflict' | 'expired'>;
  }>;
  edges: Array<{ id: string; from: string; to: string; relation: string }>;
}

export interface PracticeDefinitionProjectionV1 {
  contract: 'practice-definition-projection@1';
  course_id: string;
  version: string;
  practices: PracticeDefinitionV2[];
  assertions: AssertionDefinitionV1[];
  remediations: RemediationV1[];
  gates: GatePolicyV1[];
}

export interface TeacherReviewItemV1 {
  id: string;
  queue: 'behavior_slice_evidence' | 'low_risk_metadata' | 'conflict_high_impact';
  object_ref: string;
  object_hash: Sha256;
  reasons: string[];
}

export interface TeacherReviewProjectionV1 {
  contract: 'teacher-review-projection@1';
  course_id: string;
  version: string;
  items: TeacherReviewItemV1[];
}

export interface CoursePackageV2 {
  root: string;
  manifest: CourseManifestV2;
  nodes: PtkgNode[];
  edges: PtkgEdge[];
  sources: PtkgSource[];
  stages: CourseStageV2[];
  units: CourseUnit[];
  questions: CourseQuestion[];
  practices: PracticeDefinitionV2[];
  assertions: AssertionDefinitionV1[];
  gates: GatePolicyV1[];
  remediations: RemediationV1[];
  sourceBridges: SourceBridgeV1[];
  releaseReceipts: EvidenceEnvelopeV1[];
  reviewEvents: PublicReviewEventSummaryV1[];
  cards: CourseCard[];
  knowledgeForestProjection: KnowledgeForestProjectionV1;
  practiceDefinitionProjection: PracticeDefinitionProjectionV1;
  dreamProjection: Record<string, unknown>;
  checksums: CourseChecksumsV2;
}

export interface TeacherOverlayManifestV1 {
  contract: 'os-camp-teacher-overlay@1';
  course_id: string;
  version: string;
  public_package_root: Sha256;
  source_composition_root: Sha256;
  hidden_assertion_ids: string[];
  harness_ids: string[];
  reference_patch_ids: string[];
  answer_ids: string[];
  generator: CourseGenerator;
}

export interface TeacherOverlayIndexV1 {
  contract: 'os-camp-teacher-overlay-index@1';
  algorithm: 'sha256';
  files: Array<{ path: string; sha256: Sha256; bytes: number }>;
  root_hash: Sha256;
}

export interface ReleaseSetTrustPolicyV1 {
  trust_store_id: string;
  required_roles: Array<'release_set'>;
  worker_requires_verified_release_set: true;
  private_material_never_mounted_to_student: true;
}

export interface ReleaseSetAttestationV1 {
  spec_version: 'release-set-attestation@1';
  actor: string;
  role: 'release_set';
  key_fingerprint: string;
  public_key: string;
  release_set_root: Sha256;
  signature: string;
  signed_at: string;
}

export interface ReleaseSetV1 {
  contract: 'os-camp-release-set@1';
  course_id: string;
  version: string;
  public_package: { contract: 'os-camp-course@2'; root_hash: Sha256 };
  teacher_overlay: { contract: 'os-camp-teacher-overlay@1'; root_hash: Sha256 } | null;
  schema_versions: {
    course: 'os-camp-course@2';
    release_set: 'os-camp-release-set@1';
    teacher_overlay: 'os-camp-teacher-overlay@1';
    assertion: 'assertion-definition@1';
    evidence: 'evidence-envelope@1';
    source_composition: 'composition-manifest@1';
  };
  source_composition_root: Sha256;
  trust_policy: ReleaseSetTrustPolicyV1;
  release_set_root: Sha256;
  attestations: ReleaseSetAttestationV1[];
}
