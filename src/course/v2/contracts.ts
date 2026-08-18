import path from 'node:path';

import { canonicalJson, sha256 } from '../io.ts';
import type {
  AssertionDefinitionV1,
  AssertionResultV1,
  EvidenceEnvelopeV1,
  GatePolicyV1,
  PracticeDefinitionV2,
  ReleaseSetV1,
  SourceBridgeV1,
  SourceCompositionManifestV1,
} from './types.ts';

export type ContractIssueCode =
  | 'F1-HASH'
  | 'F1-PATH'
  | 'F1-PRACTICE'
  | 'F1-ASSERTION'
  | 'F1-EVIDENCE'
  | 'F1-BRIDGE'
  | 'F1-COMPOSITION'
  | 'F1-RELEASE';

export interface ContractIssue {
  code: ContractIssueCode;
  subject: string;
  message: string;
}

function issue(code: ContractIssueCode, subject: string, message: string): ContractIssue {
  return { code, subject, message };
}

export function v2ContentHash(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return sha256(canonicalJson(value));
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.content_hash;
  return sha256(canonicalJson(copy));
}

export function withV2ContentHash<T extends { content_hash: string }>(value: T): T {
  return { ...value, content_hash: v2ContentHash(value) };
}

export function verifyV2ContentHash(value: { content_hash: string }, subject: string): ContractIssue[] {
  const actual = v2ContentHash(value);
  return actual === value.content_hash
    ? []
    : [issue('F1-HASH', subject, `content_hash 不匹配：期望 ${actual}。`)];
}

function isSha256(value: string | null): boolean {
  return value === null || /^[0-9a-f]{64}$/.test(value);
}

function isGitOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function safeScopedPath(value: string): boolean {
  if (!value || value.includes('\\') || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../') && normalized === value;
}

export function validatePracticeDefinition(practice: PracticeDefinitionV2): ContractIssue[] {
  const findings = verifyV2ContentHash(practice, practice.id);
  if (!isSha256(practice.source.source_contract_root)
    || !isGitOid(practice.source.commit)
    || !isGitOid(practice.source.tree)) {
    findings.push(issue('F1-PRACTICE', practice.id, '实践必须绑定固定 source contract root、40 位 commit 和 tree。'));
  }
  if (practice.unit_ids.length === 0 || practice.behavior_ids.length === 0 || practice.slice_ids.length === 0) {
    findings.push(issue('F1-PRACTICE', practice.id, '实践必须引用 unit、完整行为和 learning slice。'));
  }
  const scopes = [...practice.change_policy.allowed, ...practice.change_policy.forbidden];
  for (const scope of scopes) {
    if (!safeScopedPath(scope.path)) {
      findings.push(issue('F1-PATH', practice.id, `修改边界包含不安全路径：${scope.path}`));
    }
    if (scope.kind === 'range'
      && (!scope.start_line || !scope.end_line || scope.start_line > scope.end_line)) {
      findings.push(issue('F1-PRACTICE', practice.id, `range 边界缺少合法行号：${scope.path}`));
    }
    if (scope.kind === 'symbol' && !scope.symbol) {
      findings.push(issue('F1-PRACTICE', practice.id, `symbol 边界缺少 symbol：${scope.path}`));
    }
  }
  if (practice.change_policy.mode === 'read_only' && practice.change_policy.allowed.length > 0) {
    findings.push(issue('F1-PRACTICE', practice.id, 'read_only 实践不能声明允许修改范围。'));
  }
  if (['fill', 'debug', 'test'].includes(practice.profile)
    && practice.change_policy.mode !== 'structured_diff') {
    findings.push(issue('F1-PRACTICE', practice.id, `${practice.profile} 实践必须使用 structured_diff。`));
  }
  if (practice.change_policy.mode === 'structured_diff' && practice.change_policy.allowed.length === 0) {
    findings.push(issue('F1-PRACTICE', practice.id, '修改型实践必须声明至少一个允许修改范围。'));
  }
  if (practice.assertion_ids.length === 0) {
    findings.push(issue('F1-PRACTICE', practice.id, '实践必须引用至少一个 typed assertion。'));
  }
  if (practice.execution.harness_ids.length === 0 || !practice.execution.environment_digest.includes('@sha256:')) {
    findings.push(issue('F1-PRACTICE', practice.id, '实践必须绑定受信 harness 和固定 digest 环境。'));
  }
  if (practice.hidden_material_ids.length > 0 && !practice.governance.requires_teacher_overlay) {
    findings.push(issue('F1-PRACTICE', practice.id, '引用隐藏材料的实践必须要求教师 overlay。'));
  }
  if (practice.source_continuity === 'high_fidelity_fixture'
    && practice.governance.risk !== 'high') {
    findings.push(issue('F1-PRACTICE', practice.id, 'high_fidelity_fixture 必须进入高风险教师审核。'));
  }
  if (practice.governance.risk === 'high' && practice.governance.review_event_ids.length === 0) {
    findings.push(issue('F1-PRACTICE', practice.id, '高风险实践缺少教师 review event。'));
  }
  return findings;
}

export function validateAssertionDefinition(assertion: AssertionDefinitionV1): ContractIssue[] {
  const findings = verifyV2ContentHash(assertion, assertion.id);
  if (!assertion.behavior.trim() || !assertion.invariant.trim()) {
    findings.push(issue('F1-ASSERTION', assertion.id, 'typed assertion 必须说明可观察行为与不变量。'));
  }
  if (!['trusted_harness', 'worker_observation', 'host_inspection'].includes(assertion.oracle.evidence_source)) {
    findings.push(issue('F1-ASSERTION', assertion.id, 'oracle 必须来自受信 harness、Worker 观测或宿主检查。'));
  }
  if (/marker/i.test(`${assertion.oracle.type} ${assertion.oracle.observable}`)
    && assertion.oracle.evidence_source !== 'trusted_harness') {
    findings.push(issue('F1-ASSERTION', assertion.id, '可伪造 marker 只能作为受信 oracle 的输入，不能直接裁决。'));
  }
  if (assertion.applicable_to.length === 0 || assertion.trusted_producers.length === 0) {
    findings.push(issue('F1-ASSERTION', assertion.id, 'assertion 必须声明适用运行目的和受信 producer。'));
  }
  if (assertion.assertion_class === 'fault_probe'
    && (assertion.applicable_to.length !== 1 || assertion.applicable_to[0] !== 'release_validation')) {
    findings.push(issue('F1-ASSERTION', assertion.id, 'fault_probe 只能用于 release_validation。'));
  }
  if (assertion.visibility === 'teacher_private' && !assertion.harness_id) {
    findings.push(issue('F1-ASSERTION', assertion.id, '私有 assertion 必须绑定宿主受信 harness。'));
  }
  if (assertion.not_applicable_reason && assertion.applicable_to.length > 0) {
    findings.push(issue('F1-ASSERTION', assertion.id, '已声明适用 profile 时不能同时填写 N/A 理由。'));
  }
  return findings;
}

export function validateAssertionResult(
  result: AssertionResultV1,
  assertion: AssertionDefinitionV1,
  practice: PracticeDefinitionV2,
  releaseSet: ReleaseSetV1,
): ContractIssue[] {
  const findings = verifyV2ContentHash(result, result.id);
  if (result.assertion_id !== assertion.id || result.assertion_hash !== assertion.content_hash) {
    findings.push(issue('F1-EVIDENCE', result.id, 'Assertion Result 未绑定当前 assertion ID/hash。'));
  }
  if (result.practice_id !== practice.id || result.practice_hash !== practice.content_hash) {
    findings.push(issue('F1-EVIDENCE', result.id, 'Assertion Result 未绑定当前 practice ID/hash。'));
  }
  if (result.release_set_root !== releaseSet.release_set_root
    || result.public_package_root !== releaseSet.public_package.root_hash
    || result.teacher_overlay_root !== releaseSet.teacher_overlay?.root_hash) {
    findings.push(issue('F1-RELEASE', result.id, '运行结果绑定的 public/overlay/release roots 与 Release Set 不一致。'));
  }
  if (!assertion.applicable_to.includes(result.run_purpose)) {
    findings.push(issue('F1-EVIDENCE', result.id, 'Assertion Result 使用了 Definition 未允许的运行目的。'));
  }
  if (assertion.assertion_class === 'fault_probe' && result.run_purpose !== 'release_validation') {
    findings.push(issue('F1-EVIDENCE', result.id, 'fault_probe 结果不能用于学生尝试。'));
  }
  if (assertion.visibility === 'teacher_private' && !releaseSet.teacher_overlay) {
    findings.push(issue('F1-RELEASE', result.id, '私有 assertion 缺少已绑定的教师 overlay。'));
  }
  if (result.source_contract_root !== practice.source.source_contract_root
    || result.source_commit !== practice.source.commit
    || result.source_tree !== practice.source.tree) {
    findings.push(issue('F1-EVIDENCE', result.id, '结果的源码身份与 Practice Contract 不一致。'));
  }
  if (![result.practice_hash, result.assertion_hash, result.release_set_root,
    result.public_package_root, result.source_contract_root, result.environment_hash,
    result.harness_hash, result.test_hash].every((value) => isSha256(value))) {
    findings.push(issue('F1-EVIDENCE', result.id, '结果缺少合法的契约、环境或 harness hash。'));
  }
  if (!isSha256(result.student_diff_hash) || !isSha256(result.patch_hash)
    || result.artifact_hashes.some((value) => !isSha256(value))) {
    findings.push(issue('F1-EVIDENCE', result.id, 'diff、patch 或 artifact hash 不合法。'));
  }
  if (result.status === 'passed' && result.reset.status === 'failed') {
    findings.push(issue('F1-EVIDENCE', result.id, 'reset 失败的运行不能形成 passed 结论。'));
  }
  if (result.status === 'infrastructure_error'
    && !['toolchain_failure', 'worker_failure'].includes(result.failure_category ?? '')) {
    findings.push(issue('F1-EVIDENCE', result.id, '基础设施错误必须区分 toolchain_failure 或 worker_failure。'));
  }
  if (result.status === 'failed' && result.failure_category === null) {
    findings.push(issue('F1-EVIDENCE', result.id, 'failed 结果必须给出可操作的失败分类。'));
  }
  return findings;
}

export function validateEvidenceEnvelope(evidence: EvidenceEnvelopeV1): ContractIssue[] {
  const findings = verifyV2ContentHash(evidence, evidence.id);
  if ((evidence.release_set_root === null) !== (evidence.public_package_root === null)) {
    findings.push(issue('F1-EVIDENCE', evidence.id, 'release/public roots 必须同时存在或同时处于发布前未绑定状态。'));
  }
  if (evidence.purpose !== 'release'
    && (evidence.release_set_root === null || evidence.public_package_root === null)) {
    findings.push(issue('F1-EVIDENCE', evidence.id, 'attempt/mastery 证据必须绑定最终 public package 与 Release Set roots。'));
  }
  if (evidence.purpose === 'mastery' && evidence.authority === 'student') {
    findings.push(issue('F1-EVIDENCE', evidence.id, '学生自评不能形成 mastery 证据。'));
  }
  if (evidence.status === 'accepted' && evidence.invalidated_by.length > 0) {
    findings.push(issue('F1-EVIDENCE', evidence.id, '已失效证据不能保持 accepted。'));
  }
  if (evidence.status === 'infrastructure_error' && evidence.purpose === 'mastery') {
    // 合法但只能保持 pending；由 deriveGateDecision 强制处理。
  }
  const roots = [
    evidence.trust_root,
    evidence.release_set_root,
    evidence.public_package_root,
    evidence.teacher_overlay_root,
    evidence.source.source_contract_root,
    evidence.practice_hash,
    ...evidence.object_hashes,
    ...evidence.artifact_hashes,
  ];
  if (roots.some((value) => !isSha256(value))) {
    findings.push(issue('F1-EVIDENCE', evidence.id, 'Evidence Envelope 含非法 hash。'));
  }
  return findings;
}

export type GateDecision = 'passed' | 'failed' | 'pending';

export function deriveGateDecision(
  policy: GatePolicyV1,
  evidence: EvidenceEnvelopeV1[],
): GateDecision {
  const relevant = evidence.filter((item) => (
    policy.allowed_evidence_purposes.includes(item.purpose)
    && policy.allowed_producers.includes(item.producer)
    && policy.trusted_roots.includes(item.trust_root)
  ));
  if (relevant.some((item) => item.status === 'infrastructure_error')) return 'pending';
  if (relevant.some((item) => item.status === 'rejected')) return 'failed';
  const acceptedAssertions = new Set(relevant
    .filter((item) => item.status === 'accepted' && item.invalidated_by.length === 0)
    .flatMap((item) => item.assertion_ids));
  return policy.required_assertion_ids.every((id) => acceptedAssertions.has(id)) ? 'passed' : 'pending';
}

export function validateSourceBridge(bridge: SourceBridgeV1): ContractIssue[] {
  const findings = verifyV2ContentHash(bridge, bridge.id);
  if (bridge.from_source_contract_root === bridge.to_source_contract_root) {
    findings.push(issue('F1-BRIDGE', bridge.id, 'source bridge 的 from/to 必须是不同 source contract。'));
  }
  if (!isSha256(bridge.from_source_contract_root) || !isSha256(bridge.to_source_contract_root)) {
    findings.push(issue('F1-BRIDGE', bridge.id, 'source bridge 必须绑定两个合法 source contract root。'));
  }
  if (bridge.migration_practice_id.length === 0) {
    findings.push(issue('F1-BRIDGE', bridge.id, 'source bridge 必须生成目标源码上的迁移实践。'));
  }
  if (bridge.status === 'reviewed' && !bridge.review_event_id) {
    findings.push(issue('F1-BRIDGE', bridge.id, 'reviewed source bridge 必须绑定教师高风险 review event。'));
  }
  if (bridge.inheritable_evidence_kinds.some((kind) => kind !== 'conceptual_prerequisite')) {
    findings.push(issue('F1-BRIDGE', bridge.id, '跨 source contract 只能继承已审核的概念前置。'));
  }
  const forbidden = new Set(bridge.forbidden_inheritance);
  for (const required of ['execution', 'navigation', 'diff', 'runtime'] as const) {
    if (!forbidden.has(required)) {
      findings.push(issue('F1-BRIDGE', bridge.id, `source bridge 必须禁止继承 ${required} 证据。`));
    }
  }
  return findings;
}

export function createSourceComposition(input: Omit<SourceCompositionManifestV1, 'content_hash'>): SourceCompositionManifestV1 {
  const value: SourceCompositionManifestV1 = {
    ...input,
    workspaces: [...input.workspaces].sort((a, b) => a.id.localeCompare(b.id)),
    bridge_ids: [...input.bridge_ids].sort(),
    content_hash: '',
  };
  return withV2ContentHash(value);
}

export function validateSourceComposition(
  composition: SourceCompositionManifestV1,
  bridges: SourceBridgeV1[],
): ContractIssue[] {
  const findings = verifyV2ContentHash(composition, composition.id);
  const workspaceIds = new Set<string>();
  const roots = new Set<string>();
  for (const workspace of composition.workspaces) {
    if (workspaceIds.has(workspace.id)) {
      findings.push(issue('F1-COMPOSITION', composition.id, `重复 workspace ID：${workspace.id}`));
    }
    workspaceIds.add(workspace.id);
    roots.add(workspace.source_contract_root);
    for (const hash of [workspace.workspace_root_hash, workspace.projection_root, workspace.source_contract_root]) {
      if (!isSha256(hash)) findings.push(issue('F1-COMPOSITION', workspace.id, 'workspace root 必须是 SHA-256。'));
    }
  }
  const bridgeMap = new Map(bridges.map((item) => [item.id, item]));
  for (const bridgeId of composition.bridge_ids) {
    const bridge = bridgeMap.get(bridgeId);
    if (!bridge) {
      findings.push(issue('F1-COMPOSITION', composition.id, `引用不存在的 source bridge：${bridgeId}`));
      continue;
    }
    if (!roots.has(bridge.from_source_contract_root) || !roots.has(bridge.to_source_contract_root)) {
      findings.push(issue('F1-COMPOSITION', bridge.id, 'bridge 的 source root 不在 composition workspaces 中。'));
    }
    findings.push(...validateSourceBridge(bridge));
  }
  return findings;
}
