import type { PtkgEdge, PtkgNode, PtkgSource, Severity } from '../types.ts';

export const COURSE_RULE_CODES = [
  'COURSE001',
  'COURSE002',
  'COURSE003',
  'COURSE004',
  'COURSE005',
  'COURSE006',
  'COURSE007',
  'COURSE008',
  'COURSE009',
  'COURSE010',
  'COURSE011',
  'COURSE012',
] as const;

export type CourseRuleCode = (typeof COURSE_RULE_CODES)[number];
export type CourseProfile = 'draft' | 'release';
export type CourseStageLayer = 'tutorial' | 'foundation' | 'pre_project' | 'project_reference';
export type CourseReviewStatus = 'candidate' | 'unresolved' | 'reviewed';

export const COURSE_RULE_DESCRIPTIONS: Record<CourseRuleCode, string> = {
  COURSE001: '课程包结构、必需文件或字段不合法',
  COURSE002: '路径不安全、checksum 缺失或内容被篡改',
  COURSE003: '图引用、阶段/单元依赖不存在或成环',
  COURSE004: '必修单元缺少知识卡、实践或 gate 覆盖',
  COURSE005: '必修单元缺少独立的 diagnostic/checkpoint 双题组',
  COURSE006: '实践、证据、PTKG 节点或来源引用不完整',
  COURSE007: '课程源码未绑定固定 commit/tree 或锚点证据',
  COURSE008: 'release 含候选、未决或未经教师审核的内容',
  COURSE009: 'canonical 复用、扩展或冲突声明不一致',
  COURSE010: '课程包泄漏私有路径、私有文档或本地运行数据',
  COURSE011: 'release 缺少有效且受信任的 Ed25519 教师签名',
  COURSE012: 'Dream Agent projection 与课程主数据不一致',
};

export interface CourseFinding {
  code: CourseRuleCode;
  severity: Severity;
  subject: string;
  message: string;
  file?: string;
  path?: string;
  hint?: string;
}

export interface CourseGenerator {
  tool: string;
  version: string;
  agent?: string;
}

export interface CourseManifest {
  contract: 'os-camp-course@1';
  course_id: string;
  version: string;
  title: string;
  language: string;
  package_status: 'draft' | 'release';
  curriculum_boundary: 'pre_project_readiness';
  project_ref: { repo: string; commit: string; tree: string };
  generator: CourseGenerator;
}

export interface CourseStage {
  id: string;
  layer: CourseStageLayer;
  order: number;
  title: string;
  required: boolean;
  unit_ids: string[];
  prerequisite_stage_ids: string[];
  status: CourseReviewStatus;
  source_refs: string[];
  content_hash: string;
}

export interface CourseUnit {
  id: string;
  stage_id: string;
  title: string;
  required: boolean;
  node_ids: string[];
  prerequisite_unit_ids: string[];
  source_refs: string[];
  origin_projects: string[];
  reuse_count: number;
  dependency_depth: number;
  card_ids: string[];
  question_ids: string[];
  practice_ids: string[];
  gate_ids: string[];
  status: CourseReviewStatus;
  generated_by: CourseGenerator;
  content_hash: string;
}

export interface CourseQuestion {
  id: string;
  unit_ids: string[];
  node_ids: string[];
  source_refs: string[];
  pool: 'diagnostic' | 'checkpoint';
  type: 'choice' | 'fill' | 'code' | 'design';
  prompt: string;
  options: string[];
  answer: string;
  explanation: string;
  difficulty: number;
  status: CourseReviewStatus;
  generated_by: CourseGenerator;
  content_hash: string;
}

export interface CoursePractice {
  id: string;
  unit_ids: string[];
  node_ids: string[];
  source_refs: string[];
  kind: 'observe' | 'trace' | 'code' | 'debug' | 'test' | 'review';
  title: string;
  instructions: string[];
  expected_evidence: string[];
  allowed_changes: string[];
  safety: string[];
  status: CourseReviewStatus;
  generated_by: CourseGenerator;
  content_hash: string;
}

export interface CourseGate {
  id: string;
  stage_id: string;
  unit_ids: string[];
  prerequisite_gate_ids: string[];
  evidence_kinds: string[];
  pass_policy: string;
  trusted_evidence: boolean;
  status: CourseReviewStatus;
  generated_by: CourseGenerator;
  content_hash: string;
}

export interface CourseCard {
  id: string;
  title: string;
  unit_ids: string[];
  node_ids: string[];
  source_refs: string[];
  status: CourseReviewStatus;
  generated_by: CourseGenerator;
  body: string;
  content_hash: string;
  file: string;
}

export interface CourseAttestation {
  spec_version: 'course-attestation@1';
  actor: string;
  role: 'course_release';
  key_fingerprint: string;
  public_key: string;
  root_hash: string;
  signature: string;
  signed_at: string;
}

export interface CourseChecksums {
  contract: 'os-camp-course-checksums@1';
  algorithm: 'sha256';
  files: Array<{ path: string; sha256: string; bytes: number }>;
  root_hash: string;
}

export interface CoursePackage {
  root: string;
  manifest: CourseManifest;
  nodes: PtkgNode[];
  edges: PtkgEdge[];
  sources: PtkgSource[];
  stages: CourseStage[];
  units: CourseUnit[];
  questions: CourseQuestion[];
  practices: CoursePractice[];
  gates: CourseGate[];
  cards: CourseCard[];
  attestations: CourseAttestation[];
  checksums: CourseChecksums | null;
  dreamProjection: Record<string, unknown> | null;
}

export interface CourseValidationResult {
  package: CoursePackage | null;
  profile: CourseProfile;
  passed: boolean;
  findings: CourseFinding[];
  summary: {
    total: number;
    blocker: number;
    review: number;
    info: number;
    byCode: Record<CourseRuleCode, number>;
    counts: Record<string, number>;
  };
}

export interface CourseBlueprint {
  spec_version: 'course-blueprint@1';
  course_id: string;
  version: string;
  title: string;
  language: string;
  stages: Array<Omit<CourseStage, 'content_hash'>>;
}

export interface CourseTrustKey {
  actor: string;
  public_key: string;
  key_fingerprint?: string;
  revoked?: boolean;
}

export interface CourseTrustStore {
  spec_version: 'ptkg-trust-store@1';
  keys: CourseTrustKey[];
}

export interface CourseCompileResult {
  package_dir: string;
  checksums: CourseChecksums;
  counts: Record<string, number>;
}

export interface CourseSignResult {
  package_dir: string;
  attestation: CourseAttestation;
}

export interface CoursePackResult {
  package_dir: string;
  archive: string;
  bytes: number;
  root_hash: string;
}
