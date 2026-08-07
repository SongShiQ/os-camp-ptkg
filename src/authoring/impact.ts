import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadAuthoringRun } from './loader.ts';
import { computeContentHash } from './hash.ts';
import type { AnchorVerification, AuthoringObject, AuthoringRun, ReviewEvent } from './types.ts';

type ObjectKind = 'source_contract' | 'fact' | 'coverage' | 'behavior' | 'slice' | 'execution';
export type ImpactClassification = 'non_semantic' | 'structural' | 'behavioral' | 'contractual';

interface ImpactNode {
  id: string;
  kind: ObjectKind | 'anchor' | 'review';
  content_hash?: string;
}

interface ImpactEdge {
  from: string;
  to: string;
  relation: 'references' | 'anchors' | 'input' | 'evidence' | 'projection';
}

export interface AnchorMappingCandidate {
  old_anchor_id: string;
  new_anchor_id: string;
  reason: 'same_symbol' | 'same_path';
  confidence: 'high' | 'medium';
}

export interface ImpactChange {
  id: string;
  kind: ObjectKind | 'anchor' | 'review';
  classification: ImpactClassification;
  reason: string;
  invalidates: string[];
}

export interface ImpactReport {
  spec_version: 'impact-report@0.1';
  old_run_id: string;
  new_run_id: string;
  generated_by: 'ptkg';
  classification_rules: Record<ImpactClassification, string>;
  added: ImpactChange[];
  changed: ImpactChange[];
  stale: ImpactChange[];
  inherited: ImpactChange[];
  teacher_decisions: {
    anchor_mappings: AnchorMappingCandidate[];
    reasons: string[];
  };
}

export interface ImpactIndex {
  spec_version: 'impact-index@0.1';
  run_id: string;
  nodes: ImpactNode[];
  edges: ImpactEdge[];
  reverse_dependencies: Record<string, string[]>;
}

export interface ImpactResult {
  index: ImpactIndex;
  report: ImpactReport;
  files: { index: string; report: string };
}

function objectSets(run: AuthoringRun): Array<{ kind: ObjectKind; objects: AuthoringObject[] }> {
  return [
    { kind: 'source_contract', objects: [run.sourceContract] },
    { kind: 'fact', objects: run.codeFacts },
    { kind: 'coverage', objects: [run.projectCoverage] },
    { kind: 'behavior', objects: run.behaviorChains },
    { kind: 'slice', objects: run.learningSlices },
    { kind: 'execution', objects: run.executionResults },
  ];
}

function objectMap(run: AuthoringRun): Map<string, { kind: ObjectKind; object: AuthoringObject }> {
  const result = new Map<string, { kind: ObjectKind; object: AuthoringObject }>();
  for (const { kind, objects } of objectSets(run)) {
    for (const object of objects) result.set(object.id, { kind, object });
  }
  return result;
}

function collectStringRefs(value: unknown, known: Set<string>, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (known.has(value)) found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringRefs(item, known, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStringRefs(item, known, found);
  }
  return found;
}

function anchorKey(anchor: Pick<AnchorVerification, 'path' | 'symbol'>): string {
  return `${anchor.path}\u0000${anchor.symbol ?? ''}`;
}

function makeIndex(run: AuthoringRun): ImpactIndex {
  const objects = objectMap(run);
  const anchorIds = new Set(run.anchorVerifications.map((anchor) => anchor.anchor_id));
  const known = new Set([...objects.keys(), ...anchorIds]);
  const nodes: ImpactNode[] = [];
  const edges: ImpactEdge[] = [];

  for (const [id, { kind, object }] of objects) {
    nodes.push({ id, kind, content_hash: typeof object.content_hash === 'string' ? object.content_hash : computeContentHash(object) });
    const refs = collectStringRefs(object, known);
    refs.delete(id);
    for (const ref of refs) {
      const targetKind = objects.get(ref)?.kind;
      const relation: ImpactEdge['relation'] = ref.startsWith('anchor.') ? 'anchors'
        : kind === 'execution' ? 'evidence'
          : kind === 'coverage' ? 'projection'
            : kind === 'slice' ? 'input'
              : targetKind ? 'references' : 'anchors';
      edges.push({ from: id, to: ref, relation });
    }
  }

  for (const anchor of run.anchorVerifications) {
    nodes.push({ id: anchor.anchor_id, kind: 'anchor', content_hash: computeContentHash(anchor) });
  }
  for (const event of [...run.reviewEvents, ...run.exceptionEvents]) {
    nodes.push({ id: event.event_id, kind: 'review', content_hash: computeContentHash(event) });
    if (objects.has(event.object_ref)) edges.push({ from: event.event_id, to: event.object_ref, relation: 'references' });
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => `${a.from}\u0000${a.to}\u0000${a.relation}`.localeCompare(`${b.from}\u0000${b.to}\u0000${b.relation}`));
  const reverse: Record<string, string[]> = {};
  for (const edge of edges) {
    (reverse[edge.to] ??= []).push(edge.from);
  }
  for (const ids of Object.values(reverse)) ids.sort();
  return { spec_version: 'impact-index@0.1', run_id: run.manifest.run_id, nodes, edges, reverse_dependencies: reverse };
}

function verificationMap(run: AuthoringRun): Map<string, AnchorVerification> {
  return new Map(run.anchorVerifications.map((item) => [item.anchor_id, item]));
}

function classifyObject(
  id: string,
  kind: ObjectKind,
  oldObject: AuthoringObject,
  newObject: AuthoringObject,
  oldRun: AuthoringRun,
  newRun: AuthoringRun,
): { classification: ImpactClassification; reason: string } {
  if (kind === 'source_contract') {
    return oldObject.project_ref.commit === newObject.project_ref.commit
      ? { classification: 'non_semantic', reason: 'source contract 内容变化但固定 commit 未变。' }
      : { classification: 'contractual', reason: '固定 commit 发生变化，所有仓库事实需要重新核验。' };
  }
  if (oldObject.project_ref.commit !== newObject.project_ref.commit) {
    return { classification: 'contractual', reason: '对象绑定的 project_ref.commit 发生变化。' };
  }
  if (kind === 'fact' || kind === 'behavior') {
    const oldAnchors = collectStringRefs(oldObject, new Set(oldRun.anchorVerifications.map((a) => a.anchor_id)));
    const newAnchors = collectStringRefs(newObject, new Set(newRun.anchorVerifications.map((a) => a.anchor_id)));
    const oldChecks = [...oldAnchors].map((anchor) => verificationMap(oldRun).get(anchor)).filter(Boolean) as AnchorVerification[];
    const newChecks = [...newAnchors].map((anchor) => verificationMap(newRun).get(anchor)).filter(Boolean) as AnchorVerification[];
    if (oldChecks.length === newChecks.length && oldChecks.length > 0 && oldChecks.every((item, i) => item.blob_oid === newChecks[i]?.blob_oid && item.snippet_hash === newChecks[i]?.snippet_hash)) {
      return { classification: 'non_semantic', reason: '源码 blob 与 symbol 片段未变化，仅对象元数据或文字变化。' };
    }
    return { classification: 'behavioral', reason: '事实或行为引用的源码 blob/symbol 片段发生变化。' };
  }
  if (kind === 'coverage' || kind === 'slice') return { classification: 'structural', reason: '教学覆盖或切片结构发生变化，需要教师复核依赖。' };
  if (kind === 'execution') return { classification: 'behavioral', reason: '执行结果或环境证据内容发生变化。' };
  return { classification: 'structural', reason: `${id} 的结构化对象发生变化。` };
}

function invalidatedFor(id: string, index: ImpactIndex, objectMapNew: Map<string, { kind: ObjectKind; object: AuthoringObject }>): string[] {
  const result = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const dependent of index.reverse_dependencies[current] ?? []) {
      if (result.has(dependent)) continue;
      result.add(dependent);
      queue.push(dependent);
    }
  }
  for (const dependent of [...result]) {
    if (objectMapNew.get(dependent)?.kind === 'execution') result.add(dependent);
  }
  return [...result].sort();
}

function compareAnchors(oldRun: AuthoringRun, newRun: AuthoringRun, oldIndex: ImpactIndex, newIndex: ImpactIndex): ImpactChange[] {
  const oldMap = new Map(oldRun.anchorVerifications.map((item) => [item.anchor_id, item]));
  const newMap = new Map(newRun.anchorVerifications.map((item) => [item.anchor_id, item]));
  const changes: ImpactChange[] = [];
  for (const [id, oldAnchor] of oldMap) {
    const next = newMap.get(id);
    if (!next) {
      changes.push({ id, kind: 'anchor', classification: 'structural', reason: '新运行中锚点已删除。', invalidates: invalidatedFor(id, oldIndex, new Map()) });
      continue;
    }
    if (anchorKey(oldAnchor) === anchorKey(next) && oldAnchor.blob_oid === next.blob_oid && oldAnchor.snippet_hash === next.snippet_hash && oldAnchor.status === next.status) continue;
    const contractual = oldAnchor.project_ref.commit !== next.project_ref.commit;
    const locationChanged = anchorKey(oldAnchor) !== anchorKey(next);
    changes.push({
      id,
      kind: 'anchor',
      classification: contractual ? 'contractual' : locationChanged ? 'structural' : 'behavioral',
      reason: contractual ? '锚点绑定的固定 commit 发生变化。' : locationChanged ? '锚点 path 或 symbol 发生变化，不能自动重绑。' : '锚点 blob、symbol 片段或验证状态发生变化。',
      invalidates: invalidatedFor(id, newIndex, new Map()),
    });
  }
  for (const [id, next] of newMap) {
    if (!oldMap.has(id)) changes.push({ id, kind: 'anchor', classification: 'structural', reason: '新运行新增锚点。', invalidates: [] });
  }
  return changes;
}

function anchorMappings(oldRun: AuthoringRun, newRun: AuthoringRun): AnchorMappingCandidate[] {
  const oldOnly = oldRun.anchorVerifications.filter((oldAnchor) => !newRun.anchorVerifications.some((item) => item.anchor_id === oldAnchor.anchor_id));
  const newOnly = newRun.anchorVerifications.filter((newAnchor) => !oldRun.anchorVerifications.some((item) => item.anchor_id === newAnchor.anchor_id));
  const candidates: AnchorMappingCandidate[] = [];
  for (const oldAnchor of oldOnly) {
    for (const newAnchor of newOnly) {
      if (oldAnchor.symbol && newAnchor.symbol && oldAnchor.symbol === newAnchor.symbol) {
        candidates.push({ old_anchor_id: oldAnchor.anchor_id, new_anchor_id: newAnchor.anchor_id, reason: 'same_symbol', confidence: 'high' });
      } else if (oldAnchor.path === newAnchor.path) {
        candidates.push({ old_anchor_id: oldAnchor.anchor_id, new_anchor_id: newAnchor.anchor_id, reason: 'same_path', confidence: 'medium' });
      }
    }
  }
  return candidates.sort((a, b) => `${a.old_anchor_id}\u0000${a.new_anchor_id}`.localeCompare(`${b.old_anchor_id}\u0000${b.new_anchor_id}`));
}

export async function analyzeAuthoringImpact(oldDir: string, newDir: string): Promise<ImpactResult> {
  const [oldLoaded, newLoaded] = await Promise.all([loadAuthoringRun(oldDir), loadAuthoringRun(newDir)]);
  if (!oldLoaded.run || !newLoaded.run) throw new Error('旧/新作者运行必须先满足可解析契约。');
  const oldRun = oldLoaded.run;
  const newRun = newLoaded.run;
  const oldIndex = makeIndex(oldRun);
  const index = makeIndex(newRun);
  const oldObjects = objectMap(oldRun);
  const newObjects = objectMap(newRun);
  const changes: ImpactChange[] = [];
  changes.push(...compareAnchors(oldRun, newRun, oldIndex, index));
  const inherited: ImpactChange[] = [];
  for (const [id, oldEntry] of oldObjects) {
    const next = newObjects.get(id);
    if (!next) {
      changes.push({ id, kind: oldEntry.kind, classification: 'structural', reason: '新运行中对象已删除。', invalidates: invalidatedFor(id, oldIndex, newObjects) });
      continue;
    }
    const oldHash = typeof oldEntry.object.content_hash === 'string' ? oldEntry.object.content_hash : computeContentHash(oldEntry.object);
    const newHash = typeof next.object.content_hash === 'string' ? next.object.content_hash : computeContentHash(next.object);
    if (oldHash === newHash) inherited.push({ id, kind: next.kind, classification: 'non_semantic', reason: '对象 hash 未变化，继承旧运行结果。', invalidates: [] });
    else {
      const classification = classifyObject(id, next.kind, oldEntry.object, next.object, oldRun, newRun);
      changes.push({ id, kind: next.kind, ...classification, invalidates: invalidatedFor(id, index, newObjects) });
    }
  }
  for (const [id, next] of newObjects) {
    if (!oldObjects.has(id)) changes.push({ id, kind: next.kind, classification: 'structural', reason: '新运行新增对象。', invalidates: [] });
  }
  const stale = changes.filter((item) => item.kind === 'execution' || item.kind === 'review' || item.invalidates.some((id) => id.startsWith('exec.') || id.startsWith('review.') || id.startsWith('exception.')));
  const changed = changes.filter((item) => !stale.includes(item));
  const mappings = anchorMappings(oldRun, newRun);
  const report: ImpactReport = {
    spec_version: 'impact-report@0.1',
    old_run_id: oldRun.manifest.run_id,
    new_run_id: newRun.manifest.run_id,
    generated_by: 'ptkg',
    classification_rules: {
      non_semantic: '源码证据与固定契约未变，仅元数据变化。',
      structural: '对象拓扑、覆盖或切片结构变化。',
      behavioral: '源码 blob/symbol 片段、行为或执行证据变化。',
      contractual: '固定 commit 或项目契约变化。',
    },
    added: changes.filter((item) => item.reason === '新运行新增对象。'),
    changed,
    stale,
    inherited,
    teacher_decisions: {
      anchor_mappings: mappings,
      reasons: [
        '移动或重命名的 symbol 不自动重绑，必须由教师审核候选映射。',
        ...(oldRun.manifest.project_ref.commit !== newRun.manifest.project_ref.commit ? ['固定 commit 变化，需要重新审核全部来源事实与执行证据。'] : []),
      ],
    },
  };
  const factsDir = path.join(newDir, '02-facts');
  const reportsDir = path.join(newDir, newRun.manifest.reports_dir || 'reports');
  await mkdir(factsDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });
  const indexPath = path.join(factsDir, 'impact-index.json');
  const reportPath = path.join(reportsDir, 'impact-report.json');
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { index, report, files: { index: indexPath, report: reportPath } };
}
