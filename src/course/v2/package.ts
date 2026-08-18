import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import YAML from 'yaml';

import type { PtkgEdge, PtkgNode, PtkgSource } from '../../types.ts';
import type {
  CourseCard,
  CourseFinding,
  CourseQuestion,
  CourseProfile,
  CourseStage,
  CourseUnit,
} from '../types.ts';
import {
  canonicalJson,
  canonicalJsonl,
  computeCourseContentHash,
  listCardFiles,
  listPackageFiles,
  parseCard,
  readCourseJsonl,
  renderCard,
  safeCoursePath,
  sha256,
} from '../io.ts';
import {
  validateAssertionDefinition,
  validateEvidenceEnvelope,
  validatePracticeDefinition,
  validateSourceBridge,
  verifyV2ContentHash,
  type ContractIssue,
} from './contracts.ts';
import {
  buildKnowledgeForestProjection,
  buildPracticeDefinitionProjection,
  buildTeacherReviewProjection,
} from './projections.ts';
import type {
  AssertionDefinitionV1,
  CourseChecksumsV2,
  CourseManifestV2,
  CoursePackageV2,
  EvidenceEnvelopeV1,
  GatePolicyV1,
  PracticeDefinitionV2,
  PublicReviewEventSummaryV1,
  RemediationV1,
  SourceBridgeV1,
  TeacherReviewProjectionV1,
} from './types.ts';

export const REQUIRED_COURSE_V2_FILES = [
  'manifest.yaml',
  'graph/nodes.jsonl',
  'graph/edges.jsonl',
  'graph/sources.jsonl',
  'course/stages.jsonl',
  'course/units.jsonl',
  'course/questions.jsonl',
  'course/practices.jsonl',
  'course/assertions.jsonl',
  'course/gates.jsonl',
  'course/remediations.jsonl',
  'course/source-bridges.jsonl',
  'governance/review-events.jsonl',
  'governance/release-receipts.jsonl',
  'projections/knowledge-forest-v1.json',
  'projections/practice-definition-v1.json',
  'projections/dream-agent-v2.json',
  'checksums.json',
] as const;

export interface CourseV2CompileInput {
  manifest: CourseManifestV2;
  nodes: PtkgNode[];
  edges: PtkgEdge[];
  sources: PtkgSource[];
  stages: CourseStage[];
  units: CourseUnit[];
  questions: CourseQuestion[];
  practices: PracticeDefinitionV2[];
  assertions: AssertionDefinitionV1[];
  gates: GatePolicyV1[];
  remediations: RemediationV1[];
  sourceBridges: SourceBridgeV1[];
  releaseReceipts: EvidenceEnvelopeV1[];
  cards: CourseCard[];
  reviewEvents: Array<Record<string, unknown>>;
  metadataReviewCandidates?: Array<{ id: string; content_hash: string; reasons: string[] }>;
}

export interface CourseV2CompileResult {
  package_dir: string;
  checksums: CourseChecksumsV2;
  teacher_review: TeacherReviewProjectionV1;
  counts: Record<string, number>;
}

export interface CourseV2ValidationResult {
  package: CoursePackageV2 | null;
  profile: CourseProfile;
  passed: boolean;
  findings: CourseFinding[];
  counts: Record<string, number>;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.join(HERE, '..', '..', '..', 'schema', 'course');
let validators: Record<string, ValidateFunction> | null = null;

function finding(
  code: CourseFinding['code'],
  subject: string,
  message: string,
  file?: string,
): CourseFinding {
  return { code, severity: 'blocker', subject, message, ...(file ? { file } : {}) };
}

function fromContractIssue(value: ContractIssue): CourseFinding {
  const code = value.code === 'F1-PATH' || value.code === 'F1-HASH'
    ? 'COURSE002'
    : value.code === 'F1-RELEASE'
      ? 'COURSE011'
      : value.code === 'F1-BRIDGE' || value.code === 'F1-COMPOSITION'
        ? 'COURSE003'
        : 'COURSE006';
  return finding(code, value.subject, value.message);
}

function canonicalRecords(values: Array<Record<string, unknown>>): string {
  const sorted = [...values].sort((a, b) => {
    const left = typeof a.id === 'string' ? a.id : canonicalJson(a);
    const right = typeof b.id === 'string' ? b.id : canonicalJson(b);
    return left.localeCompare(right);
  });
  return sorted.length === 0 ? '' : `${sorted.map(canonicalJson).join('\n')}\n`;
}

function publicReviewEvents(values: Array<Record<string, unknown>>): PublicReviewEventSummaryV1[] {
  const summaries: PublicReviewEventSummaryV1[] = [];
  for (const value of values) {
    const action = value.action;
    if (action !== 'accept' && action !== 'publish' && action !== 'revoke') continue;
    const eventId = typeof value.event_id === 'string' ? value.event_id : value.id;
    if (typeof eventId !== 'string'
      || typeof value.object_ref !== 'string'
      || typeof value.object_hash !== 'string'
      || typeof value.actor_id !== 'string'
      || typeof value.created_at !== 'string') continue;
    summaries.push({
      spec_version: 'public-review-event-summary@1',
      event_id: eventId,
      object_ref: value.object_ref,
      object_hash: value.object_hash,
      action,
      actor_id: value.actor_id,
      created_at: value.created_at,
    });
  }
  return summaries.sort((a, b) => a.event_id.localeCompare(b.event_id));
}

async function ensureEmpty(directory: string): Promise<void> {
  const info = await stat(directory).catch(() => null);
  if (!info) {
    await mkdir(directory, { recursive: true });
    return;
  }
  if (!info.isDirectory()) throw new Error(`Course v2 输出不是目录：${directory}`);
  if ((await readdir(directory)).length > 0) throw new Error(`Course v2 输出目录必须为空：${directory}`);
}

async function write(root: string, relative: string, content: string | Uint8Array): Promise<void> {
  const full = path.join(root, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

function uniqueIds(values: Array<{ id: string }>, label: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`${label} 出现重复 ID：${value.id}`);
    ids.add(value.id);
  }
}

export async function computeCourseV2Checksums(root: string): Promise<CourseChecksumsV2> {
  const all = await listPackageFiles(path.resolve(root));
  const included = all.filter((file) => file !== 'checksums.json' && !file.endsWith('.tgz'));
  const files: CourseChecksumsV2['files'] = [];
  for (const relative of included) {
    if (!safeCoursePath(relative)) throw new Error(`不安全的 Course v2 路径：${relative}`);
    const value = await readFile(path.join(root, relative));
    files.push({ path: relative, sha256: sha256(value), bytes: value.byteLength });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    contract: 'os-camp-course-checksums@2',
    algorithm: 'sha256',
    files,
    root_hash: sha256(`os-camp-course@2\0${canonicalJson(files)}`),
  };
}

function dreamProjection(input: CourseV2CompileInput): Record<string, unknown> {
  return {
    contract: 'dream-agent-course-projection@2',
    course_id: input.manifest.course_id,
    version: input.manifest.version,
    source_composition_root: input.manifest.source_composition_root,
    stage_ids: input.stages.map((item) => item.id).sort(),
    unit_ids: input.units.map((item) => item.id).sort(),
    question_ids: input.questions.map((item) => item.id).sort(),
    practice_ids: input.practices.map((item) => item.id).sort(),
    assertion_ids: input.assertions.filter((item) => item.visibility === 'public').map((item) => item.id).sort(),
    private_assertion_count: input.assertions.filter((item) => item.visibility === 'teacher_private').length,
    gate_ids: input.gates.map((item) => item.id).sort(),
    remediation_ids: input.remediations.map((item) => item.id).sort(),
    card_ids: input.cards.map((item) => item.id).sort(),
    graph: {
      node_ids: input.nodes.map((item) => item.id).sort(),
      edge_ids: input.edges.map((item) => item.id).sort(),
      source_ids: input.sources.map((item) => item.id).sort(),
    },
  };
}

export async function compileCourseV2(
  input: CourseV2CompileInput,
  output: string,
  options: { teacherReviewOutput?: string } = {},
): Promise<CourseV2CompileResult> {
  if (input.manifest.contract !== 'os-camp-course@2') throw new Error('Course v2 manifest contract 无效。');
  for (const [values, label] of [
    [input.nodes, 'nodes'], [input.edges, 'edges'], [input.sources, 'sources'],
    [input.stages, 'stages'], [input.units, 'units'], [input.questions, 'questions'],
    [input.practices, 'practices'], [input.assertions, 'assertions'], [input.gates, 'gates'],
    [input.remediations, 'remediations'], [input.sourceBridges, 'source bridges'], [input.cards, 'cards'],
  ] as Array<[Array<{ id: string }>, string]>) uniqueIds(values, label);

  const contractFindings = [
    ...input.practices.flatMap(validatePracticeDefinition),
    ...input.assertions.flatMap(validateAssertionDefinition),
    ...input.sourceBridges.flatMap(validateSourceBridge),
    ...input.releaseReceipts.flatMap(validateEvidenceEnvelope),
    ...input.gates.flatMap((item) => verifyV2ContentHash(item, item.id)),
    ...input.remediations.flatMap((item) => verifyV2ContentHash(item, item.id)),
  ];
  if (contractFindings.length > 0) {
    throw new Error(`Course v2 输入契约不合法：${contractFindings.map((item) => `${item.code} ${item.subject}`).join('；')}`);
  }
  const root = path.resolve(output);
  await ensureEmpty(root);
  const publicAssertions = input.assertions.filter((item) => item.visibility === 'public');
  const reviewEvents = publicReviewEvents(input.reviewEvents);
  const forest = buildKnowledgeForestProjection({
    manifest: input.manifest,
    nodes: input.nodes,
    edges: input.edges,
    stages: input.stages,
    units: input.units,
  });
  const practiceProjection = buildPracticeDefinitionProjection({
    manifest: input.manifest,
    practices: input.practices,
    assertions: input.assertions,
    remediations: input.remediations,
    gates: input.gates,
  });
  const teacherReview = buildTeacherReviewProjection({
    manifest: input.manifest,
    practices: input.practices,
    assertions: input.assertions,
    bridges: input.sourceBridges,
    metadataCandidates: input.metadataReviewCandidates,
  });
  await Promise.all([
    write(root, 'manifest.yaml', YAML.stringify(input.manifest, { lineWidth: 0 })),
    write(root, 'graph/nodes.jsonl', canonicalJsonl(input.nodes)),
    write(root, 'graph/edges.jsonl', canonicalJsonl(input.edges)),
    write(root, 'graph/sources.jsonl', canonicalJsonl(input.sources)),
    write(root, 'course/stages.jsonl', canonicalJsonl(input.stages)),
    write(root, 'course/units.jsonl', canonicalJsonl(input.units)),
    write(root, 'course/questions.jsonl', canonicalJsonl(input.questions)),
    write(root, 'course/practices.jsonl', canonicalJsonl(input.practices)),
    write(root, 'course/assertions.jsonl', canonicalJsonl(publicAssertions)),
    write(root, 'course/gates.jsonl', canonicalJsonl(input.gates)),
    write(root, 'course/remediations.jsonl', canonicalJsonl(input.remediations)),
    write(root, 'course/source-bridges.jsonl', canonicalJsonl(input.sourceBridges)),
    write(root, 'governance/review-events.jsonl', canonicalRecords(reviewEvents as unknown as Array<Record<string, unknown>>)),
    write(root, 'governance/release-receipts.jsonl', canonicalJsonl(input.releaseReceipts)),
    write(root, 'projections/knowledge-forest-v1.json', `${canonicalJson(forest)}\n`),
    write(root, 'projections/practice-definition-v1.json', `${canonicalJson(practiceProjection)}\n`),
    write(root, 'projections/dream-agent-v2.json', `${canonicalJson(dreamProjection(input))}\n`),
  ]);
  for (const card of input.cards) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(card.id)) throw new Error(`知识卡 ID 不能安全映射到路径：${card.id}`);
    await write(root, `content/cards/${card.id}.md`, renderCard(card));
  }
  const checksums = await computeCourseV2Checksums(root);
  await write(root, 'checksums.json', `${canonicalJson(checksums)}\n`);

  if (options.teacherReviewOutput) {
    const reviewPath = path.resolve(options.teacherReviewOutput);
    const relative = path.relative(root, reviewPath);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new Error('teacher-review 投影属于作者私有治理数据，不能写入公开 Course Package。');
    }
    await mkdir(path.dirname(reviewPath), { recursive: true });
    await writeFile(reviewPath, `${canonicalJson(teacherReview)}\n`, 'utf8');
  }
  return {
    package_dir: root,
    checksums,
    teacher_review: teacherReview,
    counts: {
      nodes: input.nodes.length,
      edges: input.edges.length,
      sources: input.sources.length,
      stages: input.stages.length,
      units: input.units.length,
      questions: input.questions.length,
      practices: input.practices.length,
      public_assertions: publicAssertions.length,
      private_assertions: input.assertions.length - publicAssertions.length,
      gates: input.gates.length,
      remediations: input.remediations.length,
      source_bridges: input.sourceBridges.length,
      release_receipts: input.releaseReceipts.length,
      public_review_events: reviewEvents.length,
      cards: input.cards.length,
    },
  };
}

async function getValidators(): Promise<Record<string, ValidateFunction>> {
  if (validators) return validators;
  const files = [
    'objects.schema.json',
    'objects@2.schema.json',
    'practice-evidence@1.schema.json',
    'source-composition@1.schema.json',
  ];
  const schemas = await Promise.all(files.map(async (file) => (
    JSON.parse(await readFile(path.join(SCHEMA_DIR, file), 'utf8')) as Record<string, unknown>
  )));
  const ajv = new Ajv({ allErrors: true, strict: false, formats: {
    'date-time': true,
  } });
  for (const schema of schemas) ajv.addSchema(schema);
  const refs: Record<string, string> = {
    manifest: `${String(schemas[1]?.$id)}#/$defs/manifest`,
    stage: `${String(schemas[0]?.$id)}#/$defs/stage`,
    unit: `${String(schemas[0]?.$id)}#/$defs/unit`,
    question: `${String(schemas[0]?.$id)}#/$defs/question`,
    card: `${String(schemas[0]?.$id)}#/$defs/card`,
    practice: `${String(schemas[2]?.$id)}#/$defs/practice`,
    assertion: `${String(schemas[2]?.$id)}#/$defs/assertion`,
    gate: `${String(schemas[2]?.$id)}#/$defs/gatePolicy`,
    remediation: `${String(schemas[2]?.$id)}#/$defs/remediation`,
    evidence: `${String(schemas[2]?.$id)}#/$defs/evidence`,
    bridge: `${String(schemas[3]?.$id)}#/$defs/bridge`,
    forest: `${String(schemas[1]?.$id)}#/$defs/knowledgeForestProjection`,
    publicReviewEvent: `${String(schemas[1]?.$id)}#/$defs/publicReviewEvent`,
  };
  validators = Object.fromEntries(Object.entries(refs).map(([name, ref]) => [name, ajv.compile({ $ref: ref })]));
  return validators;
}

function schemaFindings(validator: ValidateFunction, value: unknown, subject: string): CourseFinding[] {
  if (validator(value)) return [];
  return (validator.errors ?? []).map((error: ErrorObject) => finding(
    'COURSE001',
    subject,
    `${error.instancePath || '根对象'} ${error.message ?? '不符合 Course v2 Schema'}。`,
  ));
}

export async function loadCourseV2Package(root: string): Promise<{ package: CoursePackageV2 | null; findings: CourseFinding[] }> {
  const absolute = path.resolve(root);
  const missing: CourseFinding[] = [];
  for (const relative of REQUIRED_COURSE_V2_FILES) {
    if (!await stat(path.join(absolute, relative)).catch(() => null)) {
      missing.push(finding('COURSE001', relative, `缺少 Course v2 必需文件 ${relative}。`, relative));
    }
  }
  if (missing.length > 0) return { package: null, findings: missing };
  try {
    const manifest = YAML.parse(await readFile(path.join(absolute, 'manifest.yaml'), 'utf8')) as CourseManifestV2;
    if (manifest.contract !== 'os-camp-course@2') {
      return { package: null, findings: [finding('COURSE001', 'manifest', '不是 os-camp-course@2。')] };
    }
    const cards: CourseCard[] = [];
    for (const file of await listCardFiles(absolute)) {
      cards.push(parseCard(await readFile(path.join(absolute, file), 'utf8'), file));
    }
    return {
      package: {
        root: absolute,
        manifest,
        nodes: await readCourseJsonl<PtkgNode>(absolute, 'graph/nodes.jsonl'),
        edges: await readCourseJsonl<PtkgEdge>(absolute, 'graph/edges.jsonl'),
        sources: await readCourseJsonl<PtkgSource>(absolute, 'graph/sources.jsonl'),
        stages: await readCourseJsonl<CourseStage>(absolute, 'course/stages.jsonl'),
        units: await readCourseJsonl<CourseUnit>(absolute, 'course/units.jsonl'),
        questions: await readCourseJsonl<CourseQuestion>(absolute, 'course/questions.jsonl'),
        practices: await readCourseJsonl<PracticeDefinitionV2>(absolute, 'course/practices.jsonl'),
        assertions: await readCourseJsonl<AssertionDefinitionV1>(absolute, 'course/assertions.jsonl'),
        gates: await readCourseJsonl<GatePolicyV1>(absolute, 'course/gates.jsonl'),
        remediations: await readCourseJsonl<RemediationV1>(absolute, 'course/remediations.jsonl'),
        sourceBridges: await readCourseJsonl<SourceBridgeV1>(absolute, 'course/source-bridges.jsonl'),
        releaseReceipts: await readCourseJsonl<EvidenceEnvelopeV1>(absolute, 'governance/release-receipts.jsonl'),
        reviewEvents: await readCourseJsonl<PublicReviewEventSummaryV1>(absolute, 'governance/review-events.jsonl'),
        cards,
        knowledgeForestProjection: JSON.parse(await readFile(path.join(absolute, 'projections/knowledge-forest-v1.json'), 'utf8')),
        practiceDefinitionProjection: JSON.parse(await readFile(path.join(absolute, 'projections/practice-definition-v1.json'), 'utf8')),
        dreamProjection: JSON.parse(await readFile(path.join(absolute, 'projections/dream-agent-v2.json'), 'utf8')),
        checksums: JSON.parse(await readFile(path.join(absolute, 'checksums.json'), 'utf8')),
      },
      findings: [],
    };
  } catch (error) {
    return { package: null, findings: [finding('COURSE001', 'package', (error as Error).message)] };
  }
}

export async function detectCoursePackageContract(directory: string): Promise<string | null> {
  try {
    const manifest = YAML.parse(await readFile(path.join(path.resolve(directory), 'manifest.yaml'), 'utf8')) as { contract?: unknown };
    return typeof manifest.contract === 'string' ? manifest.contract : null;
  } catch {
    return null;
  }
}

function exactIds(left: string[], right: string[]): boolean {
  return canonicalJson([...left].sort()) === canonicalJson([...right].sort());
}

function validateReferences(pkg: CoursePackageV2): CourseFinding[] {
  const findings: CourseFinding[] = [];
  const units = new Set(pkg.units.map((item) => item.id));
  const practices = new Set(pkg.practices.map((item) => item.id));
  const assertions = new Set(pkg.assertions.map((item) => item.id));
  const hiddenAssertions = new Set(pkg.practices.flatMap((item) => item.hidden_material_ids));
  const gates = new Set(pkg.gates.map((item) => item.id));
  const nodes = new Set(pkg.nodes.map((item) => item.id));
  const cards = new Set(pkg.cards.map((item) => item.id));
  const bridgeIds = new Set(pkg.sourceBridges.map((item) => item.id));
  for (const practice of pkg.practices) {
    for (const unit of practice.unit_ids) if (!units.has(unit)) findings.push(finding('COURSE003', practice.id, `引用不存在的 unit ${unit}。`));
    const hiddenAssertions = new Set(practice.hidden_material_ids);
    for (const assertion of practice.assertion_ids) {
      if (!assertions.has(assertion) && !hiddenAssertions.has(assertion)) {
        findings.push(finding('COURSE003', practice.id, `assertion ${assertion} 既不在公开包，也未声明为 overlay 隐藏材料。`));
      }
    }
  }
  for (const assertion of pkg.assertions) if (!practices.has(assertion.practice_id)) findings.push(finding('COURSE003', assertion.id, 'assertion 引用不存在的实践。'));
  for (const gate of pkg.gates) {
    for (const id of gate.unit_ids) if (!units.has(id)) findings.push(finding('COURSE003', gate.id, `引用不存在的 unit ${id}。`));
    for (const id of gate.required_assertion_ids) {
      if (!assertions.has(id) && !hiddenAssertions.has(id)) findings.push(finding('COURSE003', gate.id, `assertion ${id} 既不在公开包，也未绑定教师 overlay。`));
    }
    for (const id of gate.prerequisite_gate_ids) if (!gates.has(id)) findings.push(finding('COURSE003', gate.id, `引用不存在的 gate ${id}。`));
  }
  for (const remediation of pkg.remediations) {
    if (!practices.has(remediation.practice_id) || !practices.has(remediation.retry_practice_id)) findings.push(finding('COURSE003', remediation.id, '补救链必须回到一个存在的原实践。'));
    for (const id of remediation.knowledge_node_ids) if (!nodes.has(id)) findings.push(finding('COURSE003', remediation.id, `引用不存在的知识节点 ${id}。`));
    for (const id of remediation.card_ids) if (!cards.has(id)) findings.push(finding('COURSE003', remediation.id, `引用不存在的知识卡 ${id}。`));
  }
  for (const id of pkg.manifest.source_bridge_ids) if (!bridgeIds.has(id)) findings.push(finding('COURSE003', id, 'manifest 引用不存在的 source bridge。'));
  return findings;
}

function validateReleaseReadiness(pkg: CoursePackageV2): CourseFinding[] {
  if (pkg.manifest.package_status !== 'release') return [];
  const findings: CourseFinding[] = [];
  for (const value of [...pkg.practices, ...pkg.assertions, ...pkg.gates, ...pkg.remediations, ...pkg.sourceBridges]) {
    if (value.status !== 'reviewed') findings.push(finding('COURSE008', value.id, 'release 包含未经教师审核的内容。'));
  }
  const stageById = new Map(pkg.stages.map((item) => [item.id, item]));
  const unitById = new Map(pkg.units.map((item) => [item.id, item]));
  const reviews = new Map(pkg.reviewEvents.map((item) => [item.event_id, item]));
  for (const practice of pkg.practices) {
    for (const reviewId of practice.governance.review_event_ids) {
      const review = reviews.get(reviewId);
      if (!review || review.object_ref !== practice.id || review.object_hash !== practice.content_hash || review.action !== 'accept') {
        findings.push(finding('COURSE008', practice.id, `缺少与当前 practice hash 绑定的接受事件 ${reviewId}。`));
      }
    }
  }
  for (const bridge of pkg.sourceBridges) {
    if (!bridge.review_event_id) continue;
    const review = reviews.get(bridge.review_event_id);
    if (!review || review.object_ref !== bridge.id || review.object_hash !== bridge.content_hash || review.action !== 'accept') {
      findings.push(finding('COURSE008', bridge.id, 'source bridge 的教师审核摘要缺失或 object hash 不匹配。'));
    }
  }
  for (const practice of pkg.practices) {
    const layers = practice.unit_ids.map((id) => stageById.get(unitById.get(id)?.stage_id ?? '')?.layer);
    const modification = practice.change_policy.mode === 'structured_diff';
    const needsReceipt = modification && layers.some((layer) => layer && layer !== 'project_reference');
    if (!needsReceipt) continue;
    const valid = pkg.releaseReceipts.some((receipt) => (
      receipt.purpose === 'release'
      && receipt.practice_id === practice.id
      && receipt.practice_hash === practice.content_hash
      && receipt.status === 'accepted'
      && receipt.invalidated_by.length === 0
    ));
    if (!valid) findings.push(finding('COURSE006', practice.id, '必修修改型实践缺少当前 hash 的成功 release receipt。'));
  }
  return findings;
}

function validateUnitAssets(pkg: CoursePackageV2): CourseFinding[] {
  const findings: CourseFinding[] = [];
  const cards = new Set(pkg.cards.map((item) => item.id));
  const practices = new Set(pkg.practices.map((item) => item.id));
  const gates = new Set(pkg.gates.map((item) => item.id));
  const questions = new Map(pkg.questions.map((item) => [item.id, item]));
  for (const unit of pkg.units.filter((item) => item.required)) {
    if (unit.card_ids.length === 0 || unit.card_ids.some((id) => !cards.has(id))) {
      findings.push(finding('COURSE004', unit.id, '必修单元必须包含存在的知识卡。'));
    }
    if (unit.practice_ids.length === 0 || unit.practice_ids.some((id) => !practices.has(id))) {
      findings.push(finding('COURSE004', unit.id, '必修单元必须包含完整行为实践。'));
    }
    if (unit.gate_ids.length === 0 || unit.gate_ids.some((id) => !gates.has(id))) {
      findings.push(finding('COURSE004', unit.id, '必修单元必须贡献到可信 gate。'));
    }
    const pools = unit.question_ids.map((id) => questions.get(id)).filter((item) => item !== undefined);
    const diagnostic = pools.filter((item) => item.pool === 'diagnostic').length;
    const checkpoint = pools.filter((item) => item.pool === 'checkpoint').length;
    if (diagnostic < 2 || checkpoint < 2) {
      findings.push(finding('COURSE005', unit.id, '必修单元必须至少有 2 道 diagnostic 和 2 道 checkpoint 题。'));
    }
  }
  return findings;
}

async function validateChecksums(pkg: CoursePackageV2): Promise<CourseFinding[]> {
  const findings: CourseFinding[] = [];
  if (pkg.checksums.contract !== 'os-camp-course-checksums@2') {
    findings.push(finding('COURSE002', 'checksums', 'checksums contract 不是 @2。'));
    return findings;
  }
  const actual = await computeCourseV2Checksums(pkg.root);
  if (canonicalJson(actual) !== canonicalJson(pkg.checksums)) {
    findings.push(finding('COURSE002', 'checksums', 'Course v2 文件列表、hash、大小或 root 已变化。'));
  }
  const files = await listPackageFiles(pkg.root);
  for (const relative of files) if (!safeCoursePath(relative)) findings.push(finding('COURSE002', relative, '课程包路径不安全。'));
  return findings;
}

function validateContentHashes(pkg: CoursePackageV2): CourseFinding[] {
  const findings: CourseFinding[] = [];
  for (const value of [...pkg.stages, ...pkg.units, ...pkg.questions, ...pkg.cards]) {
    if (computeCourseContentHash(value) !== value.content_hash) findings.push(finding('COURSE002', value.id, 'content_hash 与对象内容不一致。'));
  }
  for (const contractIssue of [
    ...pkg.practices.flatMap(validatePracticeDefinition),
    ...pkg.assertions.flatMap(validateAssertionDefinition),
    ...pkg.sourceBridges.flatMap(validateSourceBridge),
    ...pkg.releaseReceipts.flatMap(validateEvidenceEnvelope),
    ...pkg.gates.flatMap((item) => verifyV2ContentHash(item, item.id)),
    ...pkg.remediations.flatMap((item) => verifyV2ContentHash(item, item.id)),
  ]) findings.push(fromContractIssue(contractIssue));
  return findings;
}

function validateProjections(pkg: CoursePackageV2): CourseFinding[] {
  const expectedForest = buildKnowledgeForestProjection({
    manifest: pkg.manifest,
    nodes: pkg.nodes,
    edges: pkg.edges,
    stages: pkg.stages,
    units: pkg.units,
  });
  const expectedPractice = buildPracticeDefinitionProjection({
    manifest: pkg.manifest,
    practices: pkg.practices,
    assertions: pkg.assertions,
    remediations: pkg.remediations,
    gates: pkg.gates,
  });
  const findings: CourseFinding[] = [];
  if (canonicalJson(expectedForest) !== canonicalJson(pkg.knowledgeForestProjection)) findings.push(finding('COURSE012', 'knowledge-forest', 'knowledge-forest 投影不能由 canonical 对象等价重建。'));
  if (canonicalJson(expectedPractice) !== canonicalJson(pkg.practiceDefinitionProjection)) findings.push(finding('COURSE012', 'practice-definition', 'practice-definition 投影不能由 canonical 对象等价重建。'));
  const dream = pkg.dreamProjection as { course_id?: unknown; version?: unknown; practice_ids?: unknown; assertion_ids?: unknown };
  if (dream.course_id !== pkg.manifest.course_id || dream.version !== pkg.manifest.version
    || !Array.isArray(dream.practice_ids) || !exactIds(dream.practice_ids as string[], pkg.practices.map((item) => item.id))
    || !Array.isArray(dream.assertion_ids) || !exactIds(dream.assertion_ids as string[], pkg.assertions.map((item) => item.id))) {
    findings.push(finding('COURSE012', 'dream-agent-v2', 'Dream Agent v2 投影与 canonical 课程对象不一致。'));
  }
  return findings;
}

function validatePrivacy(pkg: CoursePackageV2): CourseFinding[] {
  const findings: CourseFinding[] = [];
  if (pkg.assertions.some((item) => item.visibility === 'teacher_private')) {
    findings.push(finding('COURSE010', 'assertions', '公开包泄漏 teacher_private assertion。'));
  }
  const forbidden = ['teacher-review-v1', 'reference-patches/', '.ptkg/private/', 'answers/'];
  const allowed = new Set<string>(REQUIRED_COURSE_V2_FILES.filter((file) => file !== 'checksums.json'));
  for (const file of pkg.checksums.files) {
    if (!allowed.has(file.path)
      && !/^content\/cards\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(file.path)) {
      findings.push(finding('COURSE010', file.path, '公开 Course v2 包含契约未允许的额外文件。'));
    }
  }
  return findings.concat(forbidden.flatMap((fragment) => {
    const leaked = pkg.checksums.files.find((item) => item.path.includes(fragment));
    return leaked ? [finding('COURSE010', leaked.path, `公开包包含私有路径片段 ${fragment}。`)] : [];
  }));
}

export async function validateCourseV2Package(
  directory: string,
  profile: CourseProfile = 'draft',
): Promise<CourseV2ValidationResult> {
  const loaded = await loadCourseV2Package(directory);
  if (!loaded.package) return { package: null, profile, passed: false, findings: loaded.findings, counts: {} };
  const pkg = loaded.package;
  const schemas = await getValidators();
  const findings = [...loaded.findings];
  const apply = (name: string, values: unknown[]): void => {
    const validator = schemas[name];
    if (!validator) return;
    for (const [index, value] of values.entries()) {
      const id = value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
        ? String((value as { id: string }).id)
        : `${name}[${index}]`;
      findings.push(...schemaFindings(validator, value, id));
    }
  };
  apply('manifest', [pkg.manifest]);
  apply('stage', pkg.stages);
  apply('unit', pkg.units);
  apply('question', pkg.questions);
  apply('card', pkg.cards);
  apply('practice', pkg.practices);
  apply('assertion', pkg.assertions);
  apply('gate', pkg.gates);
  apply('remediation', pkg.remediations);
  apply('evidence', pkg.releaseReceipts);
  apply('bridge', pkg.sourceBridges);
  apply('forest', [pkg.knowledgeForestProjection]);
  apply('publicReviewEvent', pkg.reviewEvents);
  if (profile === 'release' && pkg.manifest.package_status !== 'release') {
    findings.push(finding('COURSE008', pkg.manifest.course_id, 'release 校验要求 manifest.package_status=release。'));
  }
  findings.push(
    ...validateReferences(pkg),
    ...validateUnitAssets(pkg),
    ...validateReleaseReadiness(pkg),
    ...await validateChecksums(pkg),
    ...validateContentHashes(pkg),
    ...validateProjections(pkg),
    ...validatePrivacy(pkg),
  );
  return {
    package: pkg,
    profile,
    passed: findings.every((item) => item.severity !== 'blocker'),
    findings,
    counts: {
      nodes: pkg.nodes.length,
      edges: pkg.edges.length,
      sources: pkg.sources.length,
      stages: pkg.stages.length,
      units: pkg.units.length,
      questions: pkg.questions.length,
      practices: pkg.practices.length,
      assertions: pkg.assertions.length,
      gates: pkg.gates.length,
      remediations: pkg.remediations.length,
      source_bridges: pkg.sourceBridges.length,
      release_receipts: pkg.releaseReceipts.length,
      public_review_events: pkg.reviewEvents.length,
      cards: pkg.cards.length,
    },
  };
}

export function formatCourseV2Validation(result: CourseV2ValidationResult): string {
  const lines = [
    `Course v2 校验：${result.passed ? '通过' : '未通过'}（${result.profile}）`,
    `对象：${Object.entries(result.counts).map(([key, value]) => `${key}=${value}`).join('，') || '未载入'}`,
  ];
  if (result.findings.length === 0) lines.push('findings：0');
  else {
    lines.push(`findings：${result.findings.length}`);
    for (const item of result.findings) lines.push(`- ${item.code} ${item.subject}：${item.message}`);
  }
  if (result.profile === 'release') {
    lines.push('提示：@2 的最终激活还必须通过单独的签名 Release Set 校验。');
  }
  return lines.join('\n');
}
