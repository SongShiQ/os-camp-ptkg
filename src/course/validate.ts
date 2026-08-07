import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

import type { PtkgNode } from '../types.ts';
import {
  COURSE_RULE_CODES,
  type CourseFinding,
  type CoursePackage,
  type CourseProfile,
  type CourseRuleCode,
  type CourseValidationResult,
} from './types.ts';
import {
  canonicalJson,
  computeCourseChecksums,
  computeCourseContentHash,
  listPackageFiles,
  loadCoursePackage,
  safeCoursePath,
} from './io.ts';
import { loadCourseTrustStore, trustedCourseKey, verifyCourseAttestation } from './signature.ts';

export interface CourseValidationOptions {
  trustStore?: string;
  skipSignature?: boolean;
}

const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const COURSE_SCHEMA = path.join(HERE, '..', '..', 'schema', 'course', 'objects.schema.json');
let schemaValidators: Record<string, ValidateFunction> | null = null;

function finding(
  code: CourseRuleCode,
  subject: string,
  message: string,
  severity: CourseFinding['severity'] = 'blocker',
  file?: string,
): CourseFinding {
  return { code, severity, subject, message, ...(file ? { file } : {}) };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function getSchemaValidators(): Promise<Record<string, ValidateFunction>> {
  if (schemaValidators) return schemaValidators;
  const schema = JSON.parse(await readFile(COURSE_SCHEMA, 'utf8')) as Record<string, unknown>;
  const id = String(schema.$id);
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(schema);
  const names = ['manifest', 'stage', 'unit', 'question', 'practice', 'gate', 'card', 'checksums', 'attestation', 'projection'];
  schemaValidators = Object.fromEntries(names.map((name) => [
    name,
    ajv.compile({ $ref: `${id}#/$defs/${name}` }),
  ]));
  return schemaValidators;
}

function schemaErrors(validator: ValidateFunction, value: unknown, subject: string): CourseFinding[] {
  if (validator(value)) return [];
  return (validator.errors ?? []).map((error: ErrorObject) => finding(
    'COURSE001',
    subject,
    `${error.instancePath || '根对象'} ${error.message ?? '不符合 Course Package Schema'}。`,
  ));
}

async function validateSchemas(pkg: CoursePackage): Promise<CourseFinding[]> {
  const validators = await getSchemaValidators();
  const findings: CourseFinding[] = [];
  const apply = (name: string, values: unknown[], label: string): void => {
    const validator = validators[name];
    if (!validator) return;
    for (const [index, value] of values.entries()) {
      const subject = value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
        ? String((value as { id: string }).id)
        : `${label}[${index}]`;
      findings.push(...schemaErrors(validator, value, subject));
    }
  };
  apply('manifest', [pkg.manifest], 'manifest');
  apply('stage', pkg.stages, 'stages');
  apply('unit', pkg.units, 'units');
  apply('question', pkg.questions, 'questions');
  apply('practice', pkg.practices, 'practices');
  apply('gate', pkg.gates, 'gates');
  apply('card', pkg.cards, 'cards');
  if (pkg.checksums) apply('checksums', [pkg.checksums], 'checksums');
  apply('attestation', pkg.attestations, 'attestations');
  if (pkg.dreamProjection) apply('projection', [pkg.dreamProjection], 'projection');
  return findings;
}

function duplicateIds(values: Array<{ id?: string }>, label: string): CourseFinding[] {
  const seen = new Set<string>();
  const result: CourseFinding[] = [];
  for (const item of values) {
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      result.push(finding('COURSE001', label, `${label} 存在缺失 id 的对象。`));
    } else if (seen.has(item.id)) {
      result.push(finding('COURSE001', item.id, `${label} 的 id 重复。`));
    } else {
      seen.add(item.id);
    }
  }
  return result;
}

function findCycles(items: Array<{ id: string; prerequisites: string[] }>, label: string): CourseFinding[] {
  const graph = new Map(items.map((item) => [item.id, item.prerequisites]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: CourseFinding[] = [];
  function visit(id: string, trail: string[]): void {
    if (visiting.has(id)) {
      const start = trail.indexOf(id);
      const cycle = [...trail.slice(start), id];
      result.push(finding('COURSE003', id, `${label} 前置关系成环：${cycle.join(' -> ')}。`));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (graph.has(dependency)) visit(dependency, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id, []);
  return result;
}

function reference(
  findings: CourseFinding[],
  owner: string,
  refs: string[],
  targets: Set<string>,
  label: string,
): void {
  for (const ref of refs) {
    if (!targets.has(ref)) findings.push(finding('COURSE003', owner, `${label} 引用不存在：${ref}。`));
  }
}

function validateStructure(pkg: CoursePackage): CourseFinding[] {
  const findings: CourseFinding[] = [];
  const manifest = pkg.manifest;
  if (manifest.contract !== 'os-camp-course@1') findings.push(finding('COURSE001', 'manifest.yaml', 'contract 必须是 os-camp-course@1。'));
  for (const [label, value] of Object.entries({
    course_id: manifest.course_id,
    version: manifest.version,
    title: manifest.title,
    language: manifest.language,
  })) {
    if (typeof value !== 'string' || value.trim() === '') findings.push(finding('COURSE001', 'manifest.yaml', `${label} 不能为空。`));
  }
  if (manifest.curriculum_boundary !== 'pre_project_readiness') {
    findings.push(finding('COURSE001', 'manifest.yaml', '课程边界必须止于 pre_project_readiness。'));
  }
  if (!['draft', 'release'].includes(manifest.package_status)) {
    findings.push(finding('COURSE001', 'manifest.yaml', 'package_status 只能是 draft 或 release。'));
  }
  findings.push(
    ...duplicateIds(pkg.nodes, 'nodes'),
    ...duplicateIds(pkg.edges, 'edges'),
    ...duplicateIds(pkg.sources, 'sources'),
    ...duplicateIds(pkg.stages, 'stages'),
    ...duplicateIds(pkg.units, 'units'),
    ...duplicateIds(pkg.questions, 'questions'),
    ...duplicateIds(pkg.practices, 'practices'),
    ...duplicateIds(pkg.gates, 'gates'),
    ...duplicateIds(pkg.cards, 'cards'),
  );
  if (pkg.stages.length === 0) findings.push(finding('COURSE001', 'course/stages.jsonl', '课程至少需要一个阶段。'));
  if (pkg.units.length === 0) findings.push(finding('COURSE001', 'course/units.jsonl', '课程至少需要一个单元。'));
  const stageLayers = new Set(['tutorial', 'foundation', 'pre_project', 'project_reference']);
  for (const stage of pkg.stages) {
    if (!stageLayers.has(stage.layer)) findings.push(finding('COURSE001', stage.id, `未知阶段层级：${stage.layer}。`));
    if (!Number.isInteger(stage.order) || stage.order < 0) findings.push(finding('COURSE001', stage.id, '阶段 order 必须是非负整数。'));
  }
  return findings;
}

async function validateChecksums(pkg: CoursePackage): Promise<CourseFinding[]> {
  const findings: CourseFinding[] = [];
  let files: string[];
  try {
    files = await listPackageFiles(pkg.root);
  } catch (error) {
    return [finding('COURSE002', pkg.root, (error as Error).message)];
  }
  for (const file of files) {
    if (!safeCoursePath(file)) findings.push(finding('COURSE002', file, '课程包包含不安全路径。'));
  }
  if (!pkg.checksums || pkg.checksums.contract !== 'os-camp-course-checksums@1') {
    return [...findings, finding('COURSE002', 'checksums.json', 'checksums 契约缺失或版本不正确。')];
  }
  for (const item of pkg.checksums.files) {
    if (!safeCoursePath(item.path)) findings.push(finding('COURSE002', item.path, 'checksum 包含不安全路径。'));
  }
  const expected = await computeCourseChecksums(pkg.root);
  if (canonicalJson(expected) !== canonicalJson(pkg.checksums)) {
    findings.push(finding('COURSE002', 'checksums.json', '文件 checksum 或 package root hash 与实际内容不一致。'));
  }
  const hashables = [
    ...pkg.stages,
    ...pkg.units,
    ...pkg.questions,
    ...pkg.practices,
    ...pkg.gates,
    ...pkg.cards,
  ];
  for (const item of hashables) {
    if (!SHA64.test(item.content_hash) || item.content_hash !== computeCourseContentHash(item)) {
      findings.push(finding('COURSE002', item.id, 'content_hash 缺失或与规范化内容不一致。'));
    }
  }
  return findings;
}

function validateReferences(pkg: CoursePackage): CourseFinding[] {
  const findings: CourseFinding[] = [];
  const nodes = new Set(pkg.nodes.map((item) => item.id));
  const sources = new Set(pkg.sources.map((item) => item.id));
  const graphTargets = new Set([...nodes, ...sources]);
  const stages = new Set(pkg.stages.map((item) => item.id));
  const units = new Set(pkg.units.map((item) => item.id));
  const questions = new Set(pkg.questions.map((item) => item.id));
  const practices = new Set(pkg.practices.map((item) => item.id));
  const gates = new Set(pkg.gates.map((item) => item.id));
  const cards = new Set(pkg.cards.map((item) => item.id));
  for (const edge of pkg.edges) {
    reference(findings, edge.id, [edge.from, edge.to], graphTargets, '图边节点/来源');
    reference(findings, edge.id, strings(edge.source_ids), sources, '图边来源');
  }
  for (const node of pkg.nodes) reference(findings, node.id, strings(node.source_ids), sources, '图节点来源');
  for (const stage of pkg.stages) {
    reference(findings, stage.id, strings(stage.unit_ids), units, '阶段单元');
    reference(findings, stage.id, strings(stage.prerequisite_stage_ids), stages, '阶段前置');
    reference(findings, stage.id, strings(stage.source_refs), sources, '阶段来源');
  }
  for (const unit of pkg.units) {
    reference(findings, unit.id, [unit.stage_id], stages, '单元阶段');
    reference(findings, unit.id, strings(unit.node_ids), nodes, '单元 PTKG 节点');
    reference(findings, unit.id, strings(unit.source_refs), sources, '单元来源');
    reference(findings, unit.id, strings(unit.prerequisite_unit_ids), units, '单元前置');
    reference(findings, unit.id, strings(unit.card_ids), cards, '单元知识卡');
    reference(findings, unit.id, strings(unit.question_ids), questions, '单元题目');
    reference(findings, unit.id, strings(unit.practice_ids), practices, '单元实践');
    reference(findings, unit.id, strings(unit.gate_ids), gates, '单元 gate');
  }
  for (const item of [...pkg.questions, ...pkg.practices, ...pkg.cards]) {
    reference(findings, item.id, strings(item.unit_ids), units, '资产单元');
    reference(findings, item.id, strings(item.node_ids), nodes, '资产 PTKG 节点');
    reference(findings, item.id, strings(item.source_refs), sources, '资产来源');
  }
  for (const gate of pkg.gates) {
    reference(findings, gate.id, [gate.stage_id], stages, 'gate 阶段');
    reference(findings, gate.id, strings(gate.unit_ids), units, 'gate 单元');
    reference(findings, gate.id, strings(gate.prerequisite_gate_ids), gates, 'gate 前置');
  }
  findings.push(
    ...findCycles(pkg.stages.map((item) => ({ id: item.id, prerequisites: strings(item.prerequisite_stage_ids) })), '阶段'),
    ...findCycles(pkg.units.map((item) => ({ id: item.id, prerequisites: strings(item.prerequisite_unit_ids) })), '单元'),
    ...findCycles(pkg.gates.map((item) => ({ id: item.id, prerequisites: strings(item.prerequisite_gate_ids) })), 'gate'),
  );
  return findings;
}

function validateUnitAssets(pkg: CoursePackage): CourseFinding[] {
  const findings: CourseFinding[] = [];
  const questionById = new Map(pkg.questions.map((item) => [item.id, item]));
  const practiceById = new Map(pkg.practices.map((item) => [item.id, item]));
  const gateById = new Map(pkg.gates.map((item) => [item.id, item]));
  for (const unit of pkg.units.filter((item) => item.required)) {
    const practices = strings(unit.practice_ids).map((id) => practiceById.get(id)).filter(Boolean);
    const gates = strings(unit.gate_ids).map((id) => gateById.get(id)).filter(Boolean);
    if (strings(unit.card_ids).length === 0) findings.push(finding('COURSE004', unit.id, '必修单元缺少知识卡。'));
    if (practices.length === 0) findings.push(finding('COURSE004', unit.id, '必修单元缺少实践。'));
    if (!practices.some((item) => item && ['trace', 'code', 'debug', 'test', 'review'].includes(item.kind))) {
      findings.push(finding('COURSE004', unit.id, '必修单元缺少代码或高保真实践。'));
    }
    if (gates.length === 0) findings.push(finding('COURSE004', unit.id, '必修单元未绑定 gate 或上级 gate。'));
    if (!gates.some((item) => item?.trusted_evidence)) findings.push(finding('COURSE004', unit.id, '必修单元没有可信证据 gate。'));
    const questions = strings(unit.question_ids).map((id) => questionById.get(id)).filter(Boolean);
    const diagnostic = questions.filter((item) => item?.pool === 'diagnostic').length;
    const checkpoint = questions.filter((item) => item?.pool === 'checkpoint').length;
    if (diagnostic < 2) findings.push(finding('COURSE005', unit.id, `diagnostic/remediation 题只有 ${diagnostic} 道，至少需要 2 道。`));
    if (checkpoint < 2) findings.push(finding('COURSE005', unit.id, `checkpoint 题只有 ${checkpoint} 道，至少需要 2 道。`));
  }
  return findings;
}

function validateEvidence(pkg: CoursePackage): CourseFinding[] {
  const findings: CourseFinding[] = [];
  for (const unit of pkg.units) {
    if (strings(unit.node_ids).length === 0 || strings(unit.source_refs).length === 0) {
      findings.push(finding('COURSE006', unit.id, '单元必须同时引用 PTKG 节点和来源。'));
    }
  }
  for (const practice of pkg.practices) {
    if (strings(practice.unit_ids).length === 0 || strings(practice.node_ids).length === 0 || strings(practice.source_refs).length === 0) {
      findings.push(finding('COURSE006', practice.id, '实践缺少单元、PTKG 节点或来源引用。'));
    }
    if (strings(practice.instructions).length === 0 || strings(practice.expected_evidence).length === 0) {
      findings.push(finding('COURSE006', practice.id, '实践必须给出操作步骤和直接证据。'));
    }
  }
  for (const question of pkg.questions) {
    if (!question.prompt?.trim() || !question.answer?.trim() || !question.explanation?.trim()) {
      findings.push(finding('COURSE006', question.id, '题目缺少题干、答案或解释。'));
    }
    if (strings(question.source_refs).length === 0 || strings(question.node_ids).length === 0) {
      findings.push(finding('COURSE006', question.id, '题目缺少来源或 PTKG 节点。'));
    }
  }
  for (const card of pkg.cards) {
    if (!card.body.trim() || strings(card.source_refs).length === 0 || strings(card.node_ids).length === 0) {
      findings.push(finding('COURSE006', card.id, '知识卡正文、来源和 PTKG 节点均不能为空。'));
    }
  }
  return findings;
}

function repoArtifacts(node: PtkgNode): Array<{ ref?: string }> {
  return [
    ...(node.uses_repo_artifacts ?? []),
    ...(node.repo_artifacts ?? []),
    ...(node.type === 'repo_artifact' ? [{ ref: node.ref }] : []),
  ];
}

function validateFixedSource(pkg: CoursePackage): CourseFinding[] {
  const findings: CourseFinding[] = [];
  const { commit, tree, repo } = pkg.manifest.project_ref ?? {};
  if (typeof repo !== 'string' || !repo.trim() || !SHA40.test(commit ?? '') || !SHA40.test(tree ?? '')) {
    findings.push(finding('COURSE007', 'manifest.yaml', '课程必须绑定仓库身份、40 位 commit 和 40 位 tree。'));
  }
  if (!pkg.sources.some((source) => source.trust_level === 'A' && source.version_or_ref === commit)) {
    findings.push(finding('COURSE007', 'graph/sources.jsonl', '缺少与课程 commit 一致的 A 级固定源码来源。'));
  }
  for (const node of pkg.nodes) {
    for (const artifact of repoArtifacts(node)) {
      if (!SHA40.test(artifact.ref ?? '')) findings.push(finding('COURSE007', node.id, 'repo artifact 未绑定 40 位 commit。'));
    }
  }
  return findings;
}

function validateReview(pkg: CoursePackage, profile: CourseProfile): CourseFinding[] {
  const severity = profile === 'release' ? 'blocker' : 'review';
  const findings: CourseFinding[] = [];
  if (profile === 'release' && pkg.manifest.package_status !== 'release') {
    findings.push(finding('COURSE008', 'manifest.yaml', 'release 校验要求 package_status=release。'));
  }
  for (const item of [...pkg.stages, ...pkg.units, ...pkg.questions, ...pkg.practices, ...pkg.gates, ...pkg.cards]) {
    if (item.status !== 'reviewed') findings.push(finding('COURSE008', item.id, `课程内容状态为 ${item.status}，尚未教师审核。`, severity));
  }
  for (const item of [...pkg.nodes, ...pkg.edges]) {
    if (!['approved', 'published'].includes(item.status)) {
      findings.push(finding('COURSE008', item.id, `PTKG 状态为 ${item.status}，release 前需要教师批准。`, severity));
    }
  }
  return findings;
}

function validateReuse(pkg: CoursePackage): CourseFinding[] {
  const findings: CourseFinding[] = [];
  for (const unit of pkg.units) {
    const origins = strings(unit.origin_projects);
    if (origins.length === 0 || new Set(origins).size !== origins.length) {
      findings.push(finding('COURSE009', unit.id, 'origin_projects 必须非空且不能重复。'));
    }
    if (!Number.isInteger(unit.reuse_count) || unit.reuse_count < 0) findings.push(finding('COURSE009', unit.id, 'reuse_count 必须是非负整数。'));
    if (!Number.isInteger(unit.dependency_depth) || unit.dependency_depth < 0) findings.push(finding('COURSE009', unit.id, 'dependency_depth 必须是非负整数。'));
  }
  for (const node of pkg.nodes.filter((item) => item.type === 'knowledge')) {
    if (node.scope === 'canonical' && !node.id.startsWith('kc.')) findings.push(finding('COURSE009', node.id, 'canonical knowledge 必须使用 kc. ID。'));
  }
  return findings;
}

async function validatePrivacy(pkg: CoursePackage): Promise<CourseFinding[]> {
  const findings: CourseFinding[] = [];
  const patterns = [
    { regex: /private:\/\//i, label: 'private:// 引用' },
    { regex: /(?:^|[\s"'])(?:[a-z]:[\\/]|\/(?:Users|home)\/)/im, label: '本机绝对路径' },
    { regex: /(?:^|[\\/])\.ptkg(?:[\\/]|$)/im, label: '.ptkg 私有运行目录' },
    { regex: /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/, label: '私钥' },
  ];
  for (const file of await listPackageFiles(pkg.root).catch(() => [])) {
    const text = await readFile(path.join(pkg.root, file), 'utf8').catch(() => '');
    for (const pattern of patterns) {
      if (pattern.regex.test(text)) findings.push(finding('COURSE010', file, `课程包泄漏${pattern.label}。`));
    }
  }
  return findings;
}

async function validateSignature(
  pkg: CoursePackage,
  profile: CourseProfile,
  options: CourseValidationOptions,
): Promise<CourseFinding[]> {
  if (profile !== 'release' || options.skipSignature) return [];
  const trustFile = options.trustStore ?? process.env.PTKG_TRUST_STORE;
  const store = await loadCourseTrustStore(trustFile);
  if (!store) return [finding('COURSE011', 'governance/attestations.jsonl', 'release 校验缺少外部信任库。')];
  const rootHash = pkg.checksums?.root_hash;
  const valid = pkg.attestations.some((attestation) => (
    attestation.root_hash === rootHash
    && verifyCourseAttestation(attestation, pkg.manifest.course_id, pkg.manifest.version)
    && trustedCourseKey(attestation, store.keys)
  ));
  return valid ? [] : [finding('COURSE011', 'governance/attestations.jsonl', '没有覆盖当前 package root 的有效受信任教师签名。')];
}

function sortedIds(values: Array<{ id: string }>): string[] {
  return values.map((item) => item.id).sort();
}

function validateProjection(pkg: CoursePackage): CourseFinding[] {
  const projection = pkg.dreamProjection;
  if (!projection) return [finding('COURSE012', 'projections/dream-agent-v1.json', 'Dream Agent projection 缺失。')];
  const expected: Record<string, unknown> = {
    course_id: pkg.manifest.course_id,
    version: pkg.manifest.version,
    stage_ids: sortedIds(pkg.stages),
    unit_ids: sortedIds(pkg.units),
    question_ids: sortedIds(pkg.questions),
    practice_ids: sortedIds(pkg.practices),
    gate_ids: sortedIds(pkg.gates),
    card_ids: sortedIds(pkg.cards),
  };
  const findings: CourseFinding[] = [];
  for (const [key, value] of Object.entries(expected)) {
    if (canonicalJson(projection[key]) !== canonicalJson(value)) findings.push(finding('COURSE012', key, `Dream Agent projection 的 ${key} 与课程主数据不一致。`));
  }
  const graph = projection.graph as Record<string, unknown> | undefined;
  const graphExpected = {
    node_ids: sortedIds(pkg.nodes),
    edge_ids: sortedIds(pkg.edges),
    source_ids: sortedIds(pkg.sources),
  };
  if (!graph || canonicalJson(graph) !== canonicalJson(graphExpected)) findings.push(finding('COURSE012', 'graph', 'Dream Agent projection 的图索引与课程图谱不一致。'));
  return findings;
}

function summarize(pkg: CoursePackage | null, profile: CourseProfile, findings: CourseFinding[]): CourseValidationResult {
  const byCode = Object.fromEntries(COURSE_RULE_CODES.map((code) => [code, 0])) as Record<CourseRuleCode, number>;
  for (const item of findings) byCode[item.code]++;
  const sorted = [...findings].sort((a, b) => a.code.localeCompare(b.code) || a.subject.localeCompare(b.subject) || a.message.localeCompare(b.message));
  return {
    package: pkg,
    profile,
    passed: !sorted.some((item) => item.severity === 'blocker'),
    findings: sorted,
    summary: {
      total: sorted.length,
      blocker: sorted.filter((item) => item.severity === 'blocker').length,
      review: sorted.filter((item) => item.severity === 'review').length,
      info: sorted.filter((item) => item.severity === 'info').length,
      byCode,
      counts: pkg ? {
        nodes: pkg.nodes.length,
        edges: pkg.edges.length,
        sources: pkg.sources.length,
        stages: pkg.stages.length,
        units: pkg.units.length,
        questions: pkg.questions.length,
        practices: pkg.practices.length,
        gates: pkg.gates.length,
        cards: pkg.cards.length,
      } : {},
    },
  };
}

export async function validateCoursePackage(
  directory: string,
  profile: CourseProfile = 'draft',
  options: CourseValidationOptions = {},
): Promise<CourseValidationResult> {
  const loaded = await loadCoursePackage(directory);
  if (!loaded.package) return summarize(null, profile, loaded.findings);
  const pkg = loaded.package;
  const findings = [
    ...loaded.findings,
    ...await validateSchemas(pkg),
    ...validateStructure(pkg),
    ...await validateChecksums(pkg),
    ...validateReferences(pkg),
    ...validateUnitAssets(pkg),
    ...validateEvidence(pkg),
    ...validateFixedSource(pkg),
    ...validateReview(pkg, profile),
    ...validateReuse(pkg),
    ...await validatePrivacy(pkg),
    ...await validateSignature(pkg, profile, options),
    ...validateProjection(pkg),
  ];
  return summarize(pkg, profile, findings);
}

export function formatCourseValidation(result: CourseValidationResult): string {
  const lines = [
    `Course Package ${result.profile}: ${result.passed ? 'PASS' : 'FAIL'}`,
    `blocker=${result.summary.blocker} review=${result.summary.review} info=${result.summary.info}`,
  ];
  for (const item of result.findings) lines.push(`${item.severity.toUpperCase()} ${item.code} ${item.subject}: ${item.message}`);
  return lines.join('\n');
}
