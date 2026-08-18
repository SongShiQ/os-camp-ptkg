import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import {
  createSourceComposition,
  deriveGateDecision,
  validateAssertionDefinition,
  validateAssertionResult,
  validateEvidenceEnvelope,
  validatePracticeDefinition,
  validateSourceBridge,
  validateSourceComposition,
  withV2ContentHash,
} from '../src/course/v2/contracts.ts';
import {
  computeCourseV2Checksums,
  compileCourseV2,
  validateCourseV2Package,
  type CourseV2CompileInput,
} from '../src/course/v2/package.ts';
import { compileCourse } from '../src/course/compiler.ts';
import {
  compareReleaseSetVersions,
  computeTeacherOverlayIndex,
  createReleaseSet,
  signReleaseSet,
  validateOverlayRequirement,
  validateReleaseSet,
  validateTeacherOverlayManifest,
} from '../src/course/v2/release-set.ts';
import { signCourseV2Release, verifyCourseV2Release } from '../src/course/v2/release-workflow.ts';
import { inspectCourseV1Migration } from '../src/course/v2/migrate.ts';
import type {
  AssertionDefinitionV1,
  AssertionResultV1,
  EvidenceEnvelopeV1,
  GatePolicyV1,
  PracticeDefinitionV2,
  ReleaseSetV1,
  SourceBridgeV1,
  TeacherOverlayManifestV1,
} from '../src/course/v2/types.ts';
import {
  canonicalJson,
  computeCourseContentHash,
  listPackageFiles,
} from '../src/course/io.ts';
import type {
  CourseCard,
  CourseQuestion,
  CourseStage,
  CourseUnit,
} from '../src/course/types.ts';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);
const H4 = '4'.repeat(64);
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const BLOB = 'c'.repeat(40);
const GENERATOR = { tool: '@os-camp/ptkg', version: '0.5.0-test' };

function oldHash<T extends { content_hash: string }>(value: T): T {
  return { ...value, content_hash: computeCourseContentHash(value) };
}

function assertionDefinition(): AssertionDefinitionV1 {
  return withV2ContentHash({
    spec_version: 'assertion-definition@1',
    id: 'assertion.demo.negative',
    practice_id: 'practice.demo.modify',
    assertion_class: 'negative',
    behavior: '非法输入被拒绝且系统状态不改变',
    invariant: '失败路径不提交部分状态',
    oracle: {
      type: 'custom_harness',
      observable: '宿主 harness 读取结构化退出状态和状态快照',
      expected: '返回 EINVAL，前后状态 hash 相同',
      evidence_source: 'trusted_harness',
    },
    applicable_to: ['release_validation', 'student_attempt'],
    trusted_producers: ['worker.demo'],
    visibility: 'public',
    harness_id: 'harness.demo',
    not_applicable_reason: null,
    status: 'reviewed',
    content_hash: '',
  });
}

function practiceDefinition(): PracticeDefinitionV2 {
  return withV2ContentHash({
    spec_version: 'practice-definition@2',
    id: 'practice.demo.modify',
    course_version: '1.0.0',
    unit_ids: ['unit.demo'],
    behavior_ids: ['behavior.demo'],
    slice_ids: ['slice.demo'],
    source: {
      source_contract_id: 'source-contract.demo',
      source_contract_root: H1,
      repo: 'https://example.invalid/demo.git',
      commit: COMMIT,
      tree: TREE,
    },
    source_anchors: [{
      anchor_id: 'anchor.demo',
      path: 'src/lib.rs',
      blob_oid: BLOB,
      symbol: 'validate_input',
      start_line: 10,
      end_line: 20,
      snippet_hash: H2,
    }],
    source_continuity: 'exact',
    profile: 'debug',
    title: '修复输入校验并证明失败路径不改变状态',
    student_responsibilities: ['定位校验缺口并完成最小修复'],
    provided_scaffolding: ['固定源码与公开测试入口'],
    hidden_material_ids: [],
    change_policy: {
      mode: 'structured_diff',
      allowed: [{ kind: 'symbol', path: 'src/lib.rs', symbol: 'validate_input' }],
      forbidden: [{ kind: 'glob', path: 'tests/**' }],
    },
    assertion_ids: ['assertion.demo.negative'],
    execution: {
      trusted_commands: ['cargo test --locked'],
      environment_digest: `example.invalid/worker@sha256:${H3}`,
      harness_ids: ['harness.demo'],
      timeout_seconds: 60,
      memory_mb: 512,
      processes: 32,
      reset_required: true,
    },
    pedagogy: {
      prediction: 'optional',
      hints: [{
        level: 1,
        text: '先比较成功和失败路径的状态提交位置。',
        requires_attempt_count: 1,
        requires_failed_assertion_ids: ['assertion.demo.negative'],
      }],
      remediation_ids: ['remediation.demo'],
    },
    governance: {
      risk: 'medium',
      audience: 'student',
      visibility: 'public',
      requires_teacher_overlay: false,
      review_event_ids: ['review.demo'],
    },
    status: 'reviewed',
    generated_by: GENERATOR,
    content_hash: '',
  });
}

function gatePolicy(): GatePolicyV1 {
  return withV2ContentHash({
    spec_version: 'gate-policy@1',
    id: 'gate.demo',
    stage_id: 'stage.foundation',
    unit_ids: ['unit.demo'],
    prerequisite_gate_ids: [],
    required_assertion_ids: ['assertion.demo.negative'],
    allowed_evidence_purposes: ['release', 'mastery'],
    allowed_producers: ['worker.demo'],
    trusted_roots: [H4],
    max_age_seconds: 86400,
    decision: 'deterministic',
    status: 'reviewed',
    generated_by: GENERATOR,
    content_hash: '',
  });
}

function questions(): CourseQuestion[] {
  return [
    ['question.demo.d1', 'diagnostic'],
    ['question.demo.d2', 'diagnostic'],
    ['question.demo.c1', 'checkpoint'],
    ['question.demo.c2', 'checkpoint'],
  ].map(([id, pool]) => oldHash({
    id: id ?? '',
    unit_ids: ['unit.demo'],
    node_ids: ['kc.demo.invariant'],
    source_refs: ['src.demo'],
    pool: pool as 'diagnostic' | 'checkpoint',
    type: 'choice',
    prompt: `${id}：哪项证据能证明失败路径未改变状态？`,
    options: ['前后状态 hash 相同', '打印 PASS', '阅读过代码'],
    answer: '前后状态 hash 相同',
    explanation: '受信观测才能形成工程证据。',
    difficulty: 1,
    status: 'reviewed',
    generated_by: GENERATOR,
    content_hash: '',
  }));
}

function buildInput(): CourseV2CompileInput {
  const practice = practiceDefinition();
  const assertion = assertionDefinition();
  const gate = gatePolicy();
  const stage = oldHash<CourseStage>({
    id: 'stage.foundation',
    layer: 'foundation',
    order: 1,
    title: '基础阶段',
    required: true,
    unit_ids: ['unit.demo'],
    prerequisite_stage_ids: [],
    status: 'reviewed',
    source_refs: ['src.demo'],
    content_hash: '',
  });
  const card = oldHash<CourseCard>({
    id: 'card.demo',
    title: '失败路径状态不变量',
    unit_ids: ['unit.demo'],
    node_ids: ['kc.demo.invariant'],
    source_refs: ['src.demo'],
    status: 'reviewed',
    generated_by: GENERATOR,
    body: '比较运行前后的可信状态快照，不把日志 marker 当成通过依据。',
    content_hash: '',
    file: 'cards/card.demo.md',
  });
  const unit = oldHash<CourseUnit>({
    id: 'unit.demo',
    stage_id: stage.id,
    title: '用真实代码验证失败路径不变量',
    required: true,
    node_ids: ['kc.demo.invariant'],
    prerequisite_unit_ids: [],
    source_refs: ['src.demo'],
    origin_projects: ['project.demo'],
    reuse_count: 1,
    dependency_depth: 1,
    card_ids: [card.id],
    question_ids: questions().map((item) => item.id),
    practice_ids: [practice.id],
    gate_ids: [gate.id],
    status: 'reviewed',
    generated_by: GENERATOR,
    content_hash: '',
  });
  const remediation = withV2ContentHash({
    spec_version: 'remediation@1' as const,
    id: 'remediation.demo',
    practice_id: practice.id,
    assertion_ids: [assertion.id],
    knowledge_node_ids: ['kc.demo.invariant'],
    card_ids: [card.id],
    retry_practice_id: practice.id,
    status: 'reviewed' as const,
    content_hash: '',
  });
  const receipt = withV2ContentHash<EvidenceEnvelopeV1>({
    spec_version: 'evidence-envelope@1',
    id: 'evidence.release.demo',
    purpose: 'release',
    producer: 'worker.demo',
    authority: 'trusted_worker',
    trust_root: H4,
    course_id: 'course.demo',
    course_version: '1.0.0',
    release_set_root: null,
    public_package_root: null,
    teacher_overlay_root: null,
    source: practice.source,
    practice_id: practice.id,
    practice_hash: practice.content_hash,
    assertion_ids: [assertion.id],
    object_hashes: [assertion.content_hash],
    status: 'accepted',
    artifact_hashes: [H3],
    invalidated_by: [],
    expires_at: null,
    created_at: '2026-08-18T00:00:00.000Z',
    content_hash: '',
  });
  return {
    manifest: {
      contract: 'os-camp-course@2',
      course_id: 'course.demo',
      version: '1.0.0',
      title: 'OS 课程 v2 最小黄金样例',
      language: 'zh-CN',
      package_status: 'release',
      curriculum_boundary: 'pre_project_readiness',
      source_composition_root: H2,
      source_contract_ids: ['source-contract.demo'],
      source_bridge_ids: [],
      generator: GENERATOR,
    },
    nodes: [{
      id: 'kc.demo.invariant',
      type: 'knowledge',
      scope: 'canonical',
      title: '失败路径状态不变量',
      status: 'approved',
      statement: '学生能用可信状态快照证明错误路径没有提交部分状态。',
      source_ids: ['src.demo'],
    }],
    edges: [],
    sources: [{
      id: 'src.demo',
      type: 'source',
      source_kind: 'repo_file',
      title: '固定示例源码',
      url: 'https://example.invalid/demo/blob/fixed/src/lib.rs',
      retrieved_at: '2026-08-18',
      version_or_ref: COMMIT,
      tree_oid: TREE,
      blob_oid: BLOB,
      trust_level: 'A',
      supports: ['失败路径校验锚点'],
    }],
    stages: [stage],
    units: [unit],
    questions: questions(),
    practices: [practice],
    assertions: [assertion],
    gates: [gate],
    remediations: [remediation],
    sourceBridges: [],
    releaseReceipts: [receipt],
    cards: [card],
    reviewEvents: [{
      event_id: 'review.demo',
      action: 'accept',
      object_ref: practice.id,
      object_hash: practice.content_hash,
      actor_id: 'teacher.chen',
      created_at: '2026-08-18T00:00:00.000Z',
      private_reason: '该字段只存在于作者输入，公开摘要不得携带。',
    }],
  };
}

async function directorySnapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const file of await listPackageFiles(directory)) {
    result[file] = (await readFile(path.join(directory, file))).toString('base64');
  }
  return result;
}

test('Course v2 确定性编译三类投影，teacher-review 不进入公开包', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ptkg-f1-course-'));
  const first = path.join(temp, 'first');
  const second = path.join(temp, 'second');
  const firstReview = path.join(temp, 'review-first.json');
  const secondReview = path.join(temp, 'review-second.json');
  await compileCourseV2(buildInput(), first, { teacherReviewOutput: firstReview });
  await compileCourseV2(buildInput(), second, { teacherReviewOutput: secondReview });
  assert.deepEqual(await directorySnapshot(first), await directorySnapshot(second));
  assert.equal(await readFile(firstReview, 'utf8'), await readFile(secondReview, 'utf8'));
  assert.equal((await listPackageFiles(first)).some((file) => file.includes('teacher-review')), false);
  assert.equal((await readFile(path.join(first, 'governance', 'review-events.jsonl'), 'utf8')).includes('private_reason'), false);
  const validation = await validateCourseV2Package(first);
  assert.equal(validation.passed, true, validation.findings.map((item) => `${item.code} ${item.message}`).join('\n'));
  assert.equal(validation.package?.manifest.contract, 'os-camp-course@2');
});

test('Course v2 篡改后 checksum 和投影门 fail-closed', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ptkg-f1-tamper-'));
  const output = path.join(temp, 'course');
  await compileCourseV2(buildInput(), output);
  await writeFile(path.join(output, 'course', 'questions.jsonl'), '', 'utf8');
  const validation = await validateCourseV2Package(output);
  assert.equal(validation.passed, false);
  assert.equal(validation.findings.some((item) => item.code === 'COURSE002'), true);
  assert.equal(validation.findings.some((item) => item.code === 'COURSE005'), true);
});

test('公开 Course v2 路径白名单拒绝即使重新计算 checksum 的私有额外文件', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ptkg-f1-extra-file-'));
  const output = path.join(temp, 'course');
  await compileCourseV2(buildInput(), output);
  await mkdir(path.join(output, 'private'), { recursive: true });
  await writeFile(path.join(output, 'private', 'answer.txt'), 'hidden answer', 'utf8');
  const checksums = await computeCourseV2Checksums(output);
  await writeFile(path.join(output, 'checksums.json'), `${canonicalJson(checksums)}\n`, 'utf8');
  const validation = await validateCourseV2Package(output);
  assert.equal(validation.passed, false);
  assert.equal(validation.findings.some((item) => item.code === 'COURSE010'), true);
});

test('Practice/Assertion 合同拒绝路径穿越、marker 自证和学生 fault_probe', () => {
  const practice = practiceDefinition();
  const unsafe = withV2ContentHash({
    ...practice,
    change_policy: { ...practice.change_policy, allowed: [{ kind: 'file' as const, path: '../answer.rs' }] },
  });
  assert.equal(validatePracticeDefinition(unsafe).some((item) => item.code === 'F1-PATH'), true);

  const assertion = assertionDefinition();
  const marker = withV2ContentHash({
    ...assertion,
    oracle: { ...assertion.oracle, observable: 'guest stdout PASS marker', evidence_source: 'worker_observation' as const },
  });
  assert.equal(validateAssertionDefinition(marker).some((item) => item.message.includes('marker')), true);
  const faultProbe = withV2ContentHash({
    ...assertion,
    assertion_class: 'fault_probe' as const,
    applicable_to: ['student_attempt' as const],
  });
  assert.equal(validateAssertionDefinition(faultProbe).some((item) => item.message.includes('release_validation')), true);
});

test('source bridge/composition 确定性组合且执行证据默认不可继承', () => {
  const bridge = withV2ContentHash<SourceBridgeV1>({
    spec_version: 'source-bridge@1',
    id: 'bridge.demo.reference',
    from_source_contract_root: H1,
    to_source_contract_root: H2,
    canonical_capability_id: 'competency.demo',
    from_binding_and_anchors: [{ binding_id: 'binding.demo.base', anchor_ids: ['anchor.demo.base'] }],
    to_binding_and_anchors: [{ binding_id: 'binding.demo.reference', anchor_ids: ['anchor.demo.reference'] }],
    behavior_relation: 'partial',
    known_differences: ['参考分支增加尚未合并的状态路径'],
    inheritable_evidence_kinds: ['conceptual_prerequisite'],
    forbidden_inheritance: ['execution', 'navigation', 'diff', 'runtime'],
    migration_practice_id: 'practice.demo.migrate',
    review_event_id: 'review.bridge.demo',
    status: 'reviewed',
    content_hash: '',
  });
  const workspaces = [
    { id: 'workspace.reference', workspace_root_hash: H3, projection_root: H4, source_contract_id: 'source-contract.reference', source_contract_root: H2 },
    { id: 'workspace.base', workspace_root_hash: H4, projection_root: H3, source_contract_id: 'source-contract.base', source_contract_root: H1 },
  ];
  const first = createSourceComposition({ spec_version: 'composition-manifest@1', id: 'composition.demo', workspaces, bridge_ids: [bridge.id], status: 'reviewed' });
  const second = createSourceComposition({ spec_version: 'composition-manifest@1', id: 'composition.demo', workspaces: [...workspaces].reverse(), bridge_ids: [bridge.id], status: 'reviewed' });
  assert.equal(first.content_hash, second.content_hash);
  assert.deepEqual(validateSourceComposition(first, [bridge]), []);

  const unsafe = withV2ContentHash({ ...bridge, forbidden_inheritance: ['execution', 'navigation', 'diff'] as SourceBridgeV1['forbidden_inheritance'] });
  assert.equal(validateSourceBridge(unsafe).some((item) => item.message.includes('runtime')), true);
});

test('Release Set 同时锁定 public/overlay/composition roots 和外部信任', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const unsigned = createReleaseSet({
    courseId: 'course.demo',
    version: '1.0.0',
    publicPackageRoot: H1,
    teacherOverlayRoot: H2,
    sourceCompositionRoot: H3,
    trustStoreId: 'trust.demo',
  });
  const signed = signReleaseSet(unsigned, privatePem, 'teacher.chen', '2026-08-18T00:00:00.000Z');
  assert.deepEqual(validateReleaseSet(signed, {
    publicPackageRoot: H1,
    teacherOverlayRoot: H2,
    sourceCompositionRoot: H3,
    trustKeys: [{ actor: 'teacher.chen', public_key: publicPem }],
  }), []);
  assert.equal(validateReleaseSet(signed, {
    publicPackageRoot: H1,
    teacherOverlayRoot: H4,
    sourceCompositionRoot: H3,
    trustKeys: [{ actor: 'teacher.chen', public_key: publicPem }],
  }).some((item) => item.message.includes('overlay')), true);
  assert.equal(validateReleaseSet(signed, {
    publicPackageRoot: H1,
    teacherOverlayRoot: H2,
    sourceCompositionRoot: H3,
    trustKeys: [],
  }).some((item) => item.message.includes('签名')), true);
  const replaced = createReleaseSet({
    courseId: 'course.demo', version: '1.0.0', publicPackageRoot: H1,
    teacherOverlayRoot: H4, sourceCompositionRoot: H3, trustStoreId: 'trust.demo',
  });
  assert.equal(compareReleaseSetVersions(signed, replaced).length, 1);
});

test('私有 assertion 缺 overlay 阻断，Assertion Result 必须绑定全部 roots/hash', () => {
  const practice = withV2ContentHash({
    ...practiceDefinition(),
    hidden_material_ids: ['assertion.demo.hidden'],
    governance: { ...practiceDefinition().governance, requires_teacher_overlay: true },
  });
  const assertion = withV2ContentHash({
    ...assertionDefinition(),
    id: 'assertion.demo.hidden',
    visibility: 'teacher_private' as const,
  });
  const releaseSet = createReleaseSet({
    courseId: 'course.demo', version: '1.0.0', publicPackageRoot: H1,
    teacherOverlayRoot: null, sourceCompositionRoot: H2, trustStoreId: 'trust.demo',
  });
  assert.equal(validateOverlayRequirement(releaseSet, [practice], [assertion]).length, 1);

  const publicPractice = practiceDefinition();
  const publicAssertion = assertionDefinition();
  const boundSet = createReleaseSet({
    courseId: 'course.demo', version: '1.0.0', publicPackageRoot: H1,
    teacherOverlayRoot: H2, sourceCompositionRoot: H3, trustStoreId: 'trust.demo',
  });
  const result = withV2ContentHash<AssertionResultV1>({
    spec_version: 'assertion-result@1',
    id: 'result.demo',
    attempt_id: 'attempt.demo',
    run_purpose: 'student_attempt',
    practice_id: publicPractice.id,
    practice_hash: publicPractice.content_hash,
    assertion_id: publicAssertion.id,
    assertion_hash: publicAssertion.content_hash,
    release_set_root: boundSet.release_set_root,
    public_package_root: H1,
    teacher_overlay_root: H2,
    source_contract_root: publicPractice.source.source_contract_root,
    source_commit: COMMIT,
    source_tree: TREE,
    student_diff_hash: H3,
    patch_hash: H4,
    image_digest: `example.invalid/worker@sha256:${H1}`,
    environment_hash: H2,
    harness_hash: H3,
    test_hash: H4,
    status: 'passed',
    failure_category: null,
    artifact_hashes: [H1],
    reset: { status: 'succeeded', log_hash: H2 },
    created_at: '2026-08-18T00:00:00.000Z',
    content_hash: '',
  });
  assert.deepEqual(validateAssertionResult(result, publicAssertion, publicPractice, boundSet), []);
  const substituted = withV2ContentHash({ ...result, public_package_root: H4 });
  assert.equal(validateAssertionResult(substituted, publicAssertion, publicPractice, boundSet).some((item) => item.code === 'F1-RELEASE'), true);
});

test('infrastructure_error 只能保持 pending；学生自评不能形成 mastery', () => {
  const policy = gatePolicy();
  const practice = practiceDefinition();
  const evidence = withV2ContentHash<EvidenceEnvelopeV1>({
    spec_version: 'evidence-envelope@1',
    id: 'evidence.mastery.demo',
    purpose: 'mastery',
    producer: 'worker.demo',
    authority: 'trusted_worker',
    trust_root: H4,
    course_id: 'course.demo',
    course_version: '1.0.0',
    release_set_root: H1,
    public_package_root: H2,
    teacher_overlay_root: null,
    source: practice.source,
    practice_id: practice.id,
    practice_hash: practice.content_hash,
    assertion_ids: ['assertion.demo.negative'],
    object_hashes: [H3],
    status: 'infrastructure_error',
    artifact_hashes: [H4],
    invalidated_by: [],
    expires_at: null,
    created_at: '2026-08-18T00:00:00.000Z',
    content_hash: '',
  });
  assert.equal(deriveGateDecision(policy, [evidence]), 'pending');
  const selfReport = withV2ContentHash({ ...evidence, status: 'accepted' as const, authority: 'student' as const });
  assert.equal(validateEvidenceEnvelope(selfReport).some((item) => item.message.includes('自评')), true);
});

test('教师 overlay 索引确定性，manifest 必须绑定公开包和 composition', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ptkg-f1-overlay-'));
  const manifest: TeacherOverlayManifestV1 = {
    contract: 'os-camp-teacher-overlay@1',
    course_id: 'course.demo',
    version: '1.0.0',
    public_package_root: H1,
    source_composition_root: H2,
    hidden_assertion_ids: ['assertion.demo.hidden'],
    harness_ids: ['harness.demo'],
    reference_patch_ids: [],
    answer_ids: [],
    generator: GENERATOR,
  };
  await writeFile(path.join(temp, 'manifest.yaml'), YAML.stringify(manifest), 'utf8');
  await writeFile(path.join(temp, 'assertions.jsonl'), `${canonicalJson({ id: 'assertion.demo.hidden', hash: H3 })}\n`, 'utf8');
  const first = await computeTeacherOverlayIndex(temp);
  const second = await computeTeacherOverlayIndex(temp);
  assert.deepEqual(first, second);
  assert.deepEqual(validateTeacherOverlayManifest(manifest, {
    courseId: 'course.demo', version: '1.0.0', publicPackageRoot: H1, sourceCompositionRoot: H2,
  }), []);
  await writeFile(path.join(temp, 'assertions.jsonl'), `${canonicalJson({ id: 'assertion.demo.hidden', hash: H4 })}\n`, 'utf8');
  const changed = await computeTeacherOverlayIndex(temp);
  assert.notEqual(first.root_hash, changed.root_hash);
});

test('Course v2 发布工作流先锁公开包，再签 Release Set，篡改后拒绝', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ptkg-f1-release-'));
  const packageDir = path.join(temp, 'course');
  const releaseSetFile = path.join(temp, 'release-set.json');
  const keyFile = path.join(temp, 'teacher.pem');
  const trustFile = path.join(temp, 'trust.json');
  await compileCourseV2(buildInput(), packageDir);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  await writeFile(keyFile, privatePem, 'utf8');
  await writeFile(trustFile, `${JSON.stringify({
    spec_version: 'ptkg-trust-store@1',
    keys: [{ actor: 'teacher.chen', public_key: publicPem }],
  })}\n`, 'utf8');
  const signed = await signCourseV2Release({
    packageDir,
    outputFile: releaseSetFile,
    keyFile,
    actor: 'teacher.chen',
    trustStoreId: 'trust.demo',
  });
  assert.equal(signed.release_set.teacher_overlay, null);
  const verified = await verifyCourseV2Release({
    releaseSetFile,
    packageDir,
    trustStoreFile: trustFile,
  });
  assert.equal(verified.passed, true, verified.findings.map((item) => item.message).join('\n'));
  await writeFile(path.join(packageDir, 'content', 'cards', 'card.demo.md'), 'tampered\n', 'utf8');
  const rejected = await verifyCourseV2Release({
    releaseSetFile,
    packageDir,
    trustStoreFile: trustFile,
  });
  assert.equal(rejected.passed, false);
  assert.equal(rejected.findings.some((item) => item.code === 'COURSE001' || item.code === 'COURSE002'), true);
});

test('旧 @1 课程迁移只生成诚实缺口，不把布尔证据伪造为 @2', async () => {
  const fixture = path.resolve(import.meta.dirname, '..', 'fixtures', 'authoring', 'cgroup-golden');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ptkg-f1-migrate-'));
  const packageDir = path.join(temp, 'course-v1');
  await compileCourse(fixture, packageDir);
  const report = await inspectCourseV1Migration(packageDir);
  assert.equal(report.source_contract, 'os-camp-course@1');
  assert.equal(report.target_contract, 'os-camp-course@2');
  assert.equal(report.blocker_count > 0, true);
  assert.equal(report.objects.some((item) => item.missing_fields.includes('typed_assertion_ids_and_oracles')), true);
  assert.equal(report.objects.some((item) => item.notes.some((note) => note.includes('trusted_evidence'))), true);
});

test('需要隐藏 assertion 的课程必须同时签入教师 overlay，公开包不泄漏定义', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ptkg-f1-private-release-'));
  const packageDir = path.join(temp, 'course');
  const overlayDir = path.join(temp, 'overlay');
  const releaseSetFile = path.join(temp, 'release-set.json');
  const keyFile = path.join(temp, 'teacher.pem');
  const trustFile = path.join(temp, 'trust.json');
  const input = buildInput();
  const hidden = withV2ContentHash<AssertionDefinitionV1>({
    ...assertionDefinition(),
    id: 'assertion.demo.hidden',
    visibility: 'teacher_private',
    content_hash: '',
  });
  const practice = withV2ContentHash<PracticeDefinitionV2>({
    ...input.practices[0]!,
    assertion_ids: ['assertion.demo.negative', hidden.id],
    hidden_material_ids: [hidden.id],
    governance: { ...input.practices[0]!.governance, requires_teacher_overlay: true },
    content_hash: '',
  });
  input.practices = [practice];
  input.assertions = [input.assertions[0]!, hidden];
  input.reviewEvents = input.reviewEvents.map((event) => ({ ...event, object_hash: practice.content_hash }));
  input.releaseReceipts = input.releaseReceipts.map((receipt) => withV2ContentHash({
    ...receipt,
    practice_hash: practice.content_hash,
    content_hash: '',
  }));
  await compileCourseV2(input, packageDir);
  await mkdir(overlayDir, { recursive: true });
  const overlayManifest: TeacherOverlayManifestV1 = {
    contract: 'os-camp-teacher-overlay@1',
    course_id: input.manifest.course_id,
    version: input.manifest.version,
    public_package_root: H1,
    source_composition_root: input.manifest.source_composition_root,
    hidden_assertion_ids: [hidden.id],
    harness_ids: ['harness.demo'],
    reference_patch_ids: [],
    answer_ids: [],
    generator: GENERATOR,
  };
  await writeFile(path.join(overlayDir, 'manifest.yaml'), YAML.stringify(overlayManifest), 'utf8');
  await writeFile(path.join(overlayDir, 'assertions.jsonl'), `${canonicalJson(hidden)}\n`, 'utf8');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8');
  await writeFile(trustFile, `${JSON.stringify({
    spec_version: 'ptkg-trust-store@1',
    keys: [{ actor: 'teacher.chen', public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
  })}\n`, 'utf8');
  const signed = await signCourseV2Release({
    packageDir,
    overlayDir,
    outputFile: releaseSetFile,
    keyFile,
    actor: 'teacher.chen',
    trustStoreId: 'trust.demo',
  });
  assert.notEqual(signed.teacher_overlay_root, null);
  const publicAssertions = await readFile(path.join(packageDir, 'course', 'assertions.jsonl'), 'utf8');
  assert.equal(publicAssertions.includes(hidden.id), false);
  const verified = await verifyCourseV2Release({ releaseSetFile, packageDir, overlayDir, trustStoreFile: trustFile });
  assert.equal(verified.passed, true, verified.findings.map((item) => item.message).join('\n'));
});
