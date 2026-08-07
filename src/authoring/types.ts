import type { Severity } from '../types.ts';

export const AUTHORING_RULE_CODES = [
  'CANDIDATE-CONTRACT-001',
  'CANDIDATE-CLAIM-001',
  'CANDIDATE-ANCHOR-001',
  'CANDIDATE-BEHAVIOR-001',
  'CANDIDATE-BEHAVIOR-002',
  'CANDIDATE-SCAFFOLD-001',
  'CANDIDATE-EVIDENCE-001',
  'CANDIDATE-EXEC-001',
  'CANDIDATE-TEST-001',
  'CANDIDATE-COVERAGE-001',
  'CANDIDATE-COVERAGE-002',
  'CANDIDATE-REUSE-001',
  'CANDIDATE-REVIEW-001',
  'CANDIDATE-EXCEPTION-001',
  'CANDIDATE-SANDBOX-001',
  'CANDIDATE-UPDATE-001',
] as const;

export type AuthoringRuleCode = (typeof AUTHORING_RULE_CODES)[number];
export type AuthoringProfile = 'authoring' | 'review' | 'publishing';

export const AUTHORING_RULE_DESCRIPTIONS: Record<AuthoringRuleCode, string> = {
  'CANDIDATE-CONTRACT-001': '作者链契约结构或版本不合法',
  'CANDIDATE-CLAIM-001': '关键 claim 缺认识状态、来源或验证方法',
  'CANDIDATE-ANCHOR-001': 'verified claim 引用未声明的代码锚点',
  'CANDIDATE-BEHAVIOR-001': '行为链缺少通用闭包字段',
  'CANDIDATE-BEHAVIOR-002': '状态/资源变更链缺失败、清理、不变量或并发说明',
  'CANDIDATE-SCAFFOLD-001': '脚手架提供/隐藏边界冲突或泄露责任',
  'CANDIDATE-EVIDENCE-001': '证据强度低于 S0-S4 能力主张',
  'CANDIDATE-EXEC-001': '执行记录缺失或结果不满足切片要求',
  'CANDIDATE-TEST-001': 'S3 测试不能区分正确实现与 seeded fault',
  'CANDIDATE-COVERAGE-001': 'required coverage unit 缺席',
  'CANDIDATE-COVERAGE-002': '覆盖状态未达到声明的发布层级',
  'CANDIDATE-REUSE-001': '不满足语义对齐条件却声明 exact_reuse',
  'CANDIDATE-REVIEW-001': '审核身份、对象 hash 或 publishing 权限不可信',
  'CANDIDATE-EXCEPTION-001': '例外缺少范围、期限、补偿措施或必要角色',
  'CANDIDATE-SANDBOX-001': '执行缺少资源、网络、文件系统或重置边界',
  'CANDIDATE-UPDATE-001': '同一作者运行混用 commit 或静默移动基线',
};

export interface AuthoringFinding {
  code: AuthoringRuleCode;
  severity: Severity;
  subject: string;
  message: string;
  file?: string;
  path?: string;
  hint?: string;
}

export interface ProjectRef {
  repo: string;
  commit: string;
}

export interface Claim {
  id: string;
  statement: string;
  epistemic_status:
    | 'verified_fact'
    | 'supported_inference'
    | 'pedagogical_proposal'
    | 'teacher_decision'
    | 'unresolved';
  source_refs: string[];
  anchor_refs: string[];
  event_refs?: string[];
  method: string;
  verified_at?: string;
  validity?: {
    commit_bound: boolean;
    invalidates_on: string[];
  };
}

export interface AuthoringObject {
  spec_version: string;
  id: string;
  run_id: string;
  project_ref: ProjectRef;
  status: 'candidate' | 'unresolved';
  input_refs: string[];
  claims: Claim[];
  content_hash: string;
  [key: string]: unknown;
}

export interface ReviewEvent {
  spec_version: 'review-event@0.1';
  event_id: string;
  run_id: string;
  object_ref: string;
  object_hash: string;
  action: 'accept' | 'reject' | 'request_changes' | 'approve_exception' | 'publish' | 'revoke';
  actor_id: string;
  actor_roles: string[];
  authentication: 'authenticated' | 'local_unverified_review';
  reason: string;
  scope: string[];
  rule_code?: string;
  compensating_controls?: string[];
  expires_at?: string;
  bound_commit?: string;
  invalidates_on?: string[];
  created_at: string;
}

export interface RunManifest {
  authoring_version: '0.1';
  run_id: string;
  profile: AuthoringProfile;
  project_ref: ProjectRef;
  reports_dir: string;
}

export interface AnchorVerification {
  anchor_id: string;
  project_ref: ProjectRef;
  path: string;
  symbol: string | null;
  status: 'verified' | 'unresolved';
  blob_oid?: string;
  symbol_start_line?: number;
  symbol_end_line?: number;
  parser: 'git-path' | 'rust-declaration-v1';
  snippet_hash?: string;
  reason?: string;
}

export interface AuthoringRun {
  root: string;
  manifest: RunManifest;
  sourceContract: AuthoringObject;
  codeFacts: AuthoringObject[];
  projectCoverage: AuthoringObject;
  behaviorChains: AuthoringObject[];
  learningSlices: AuthoringObject[];
  executionResults: AuthoringObject[];
  reviewEvents: ReviewEvent[];
  exceptionEvents: ReviewEvent[];
  anchorVerifications: AnchorVerification[];
  projectionDir: string;
  origin: {
    sourceContract: string;
    codeFacts: string;
    projectCoverage: string;
    behaviorChains: string;
    learningSlices: string;
    executionResults: string;
    reviewEvents: string;
    exceptionEvents: string;
    anchorVerifications: string;
  };
}

export interface LoadAuthoringResult {
  run: AuthoringRun | null;
  findings: AuthoringFinding[];
}

export interface AuthoringValidateResult {
  run: AuthoringRun | null;
  findings: AuthoringFinding[];
  summary: {
    total: number;
    blocker: number;
    review: number;
    info: number;
    byCode: Record<string, number>;
    counts: Record<string, number>;
  };
  passed: boolean;
  profile: AuthoringProfile;
}
