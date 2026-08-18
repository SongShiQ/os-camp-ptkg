import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { loadBundle } from '../../loader.ts';
import type { PtkgBundle } from '../../types.ts';
import { loadProjectInput } from '../../project/workspace.ts';
import type {
  CourseCard,
  CourseQuestion,
  CourseStage,
  CourseUnit,
} from '../types.ts';
import {
  computeCourseContentHash,
  parseCard,
  readCourseJsonl,
} from '../io.ts';
import {
  createSourceComposition,
  validateSourceComposition,
} from './contracts.ts';
import {
  compileCourseV2,
  type CourseV2CompileResult,
} from './package.ts';
import type {
  AssertionDefinitionV1,
  EvidenceEnvelopeV1,
  GatePolicyV1,
  PracticeDefinitionV2,
  RemediationV1,
  SourceBridgeV1,
  SourceCompositionManifestV1,
} from './types.ts';

interface CourseBlueprintV2 {
  spec_version: 'course-blueprint@2';
  course_id: string;
  version: string;
  title: string;
  language: string;
  stages: Array<Omit<CourseStage, 'content_hash'>>;
}

function withLegacyHash<T extends { content_hash: string }>(value: T): T {
  return { ...value, content_hash: computeCourseContentHash(value) };
}

async function readOptionalJsonl<T>(root: string, relative: string): Promise<T[]> {
  const info = await stat(path.join(root, relative)).catch(() => null);
  return info?.isFile() ? readCourseJsonl<T>(root, relative) : [];
}

function canonicalLocalRepo(commit: string): string {
  return `local-git:${commit}`;
}

function redactLocalRepository(bundle: PtkgBundle, locator: string, replacement: string): PtkgBundle {
  const variants = new Set([
    locator,
    path.resolve(locator),
    path.resolve(locator).replaceAll('\\', '/'),
  ]);
  function visit(value: unknown): unknown {
    if (typeof value === 'string') return variants.has(value) ? replacement : value;
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [key, visit(child)]));
    }
    return value;
  }
  return visit(bundle) as PtkgBundle;
}

async function loadCards(workspace: string): Promise<CourseCard[]> {
  const directory = path.join(workspace, '09-course', 'cards');
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
  const cards: CourseCard[] = [];
  for (const file of files) {
    const parsed = parseCard(await readFile(path.join(directory, file), 'utf8'), `cards/${file}`);
    cards.push(withLegacyHash(parsed));
  }
  return cards.sort((a, b) => a.id.localeCompare(b.id));
}

export async function compileCourseV2Workspace(
  workspace: string,
  output: string,
): Promise<CourseV2CompileResult> {
  const root = path.resolve(workspace);
  const input = await loadProjectInput(root);
  const loaded = await loadBundle(path.join(root, '07-projection'));
  if (!loaded.bundle || loaded.findings.some((item) => item.severity === 'blocker')) {
    throw new Error(`PTKG projection 无法编译为 Course v2：${loaded.findings.map((item) => item.message).join('；')}`);
  }
  const blueprint = YAML.parse(
    await readFile(path.join(root, '09-course', 'blueprint-v2.yaml'), 'utf8'),
  ) as CourseBlueprintV2;
  if (blueprint.spec_version !== 'course-blueprint@2') {
    throw new Error('09-course/blueprint-v2.yaml 必须使用 course-blueprint@2。');
  }
  const bridges = await readCourseJsonl<SourceBridgeV1>(root, '09-course/source-bridges.jsonl');
  const rawComposition = JSON.parse(
    await readFile(path.join(root, '09-course', 'composition-manifest.json'), 'utf8'),
  ) as SourceCompositionManifestV1;
  const composition = createSourceComposition({
    spec_version: rawComposition.spec_version,
    id: rawComposition.id,
    workspaces: rawComposition.workspaces,
    bridge_ids: rawComposition.bridge_ids,
    status: rawComposition.status,
  });
  if (rawComposition.content_hash !== composition.content_hash) {
    throw new Error('composition-manifest.json 的 content_hash 与规范化内容不一致。');
  }
  const compositionFindings = validateSourceComposition(composition, bridges);
  if (compositionFindings.length > 0) {
    throw new Error(`source composition 无法编译：${compositionFindings.map((item) => `${item.code} ${item.subject}`).join('；')}`);
  }
  const repo = input.repository.kind === 'local'
    ? canonicalLocalRepo(input.repository.commit)
    : loaded.bundle.manifest.project_ref.repository_url;
  const bundle = input.repository.kind === 'local'
    ? redactLocalRepository(loaded.bundle, input.repository.locator, repo)
    : loaded.bundle;
  const stages = blueprint.stages.map((stage) => withLegacyHash({ ...stage, content_hash: '' }));
  const practices = await readCourseJsonl<PracticeDefinitionV2>(root, '09-course/practices.jsonl');
  const assertions = await readCourseJsonl<AssertionDefinitionV1>(root, '09-course/assertions.jsonl');
  const gates = await readCourseJsonl<GatePolicyV1>(root, '09-course/gates.jsonl');
  const remediations = await readCourseJsonl<RemediationV1>(root, '09-course/remediations.jsonl');
  const reviewEvents = await readOptionalJsonl<Record<string, unknown>>(root, '08-governance/review-events.jsonl');
  const releaseReceipts = await readOptionalJsonl<EvidenceEnvelopeV1>(root, '06-evidence/release-receipts.jsonl');
  const sourceContractIds = [...new Set(composition.workspaces.map((item) => item.source_contract_id))].sort();

  return compileCourseV2({
    manifest: {
      contract: 'os-camp-course@2',
      course_id: blueprint.course_id,
      version: blueprint.version,
      title: blueprint.title,
      language: blueprint.language,
      package_status: 'draft',
      curriculum_boundary: 'pre_project_readiness',
      source_composition_root: composition.content_hash,
      source_contract_ids: sourceContractIds,
      source_bridge_ids: composition.bridge_ids,
      generator: { tool: '@os-camp/ptkg', version: '0.5.0' },
    },
    nodes: bundle.nodes,
    edges: bundle.edges,
    sources: bundle.sources,
    stages,
    units: await readCourseJsonl<CourseUnit>(root, '09-course/units.jsonl'),
    questions: await readCourseJsonl<CourseQuestion>(root, '09-course/questions.jsonl'),
    practices,
    assertions,
    gates,
    remediations,
    sourceBridges: bridges,
    releaseReceipts,
    cards: await loadCards(root),
    reviewEvents,
  }, output, {
    teacherReviewOutput: path.join(root, '.ptkg', 'review', 'teacher-review-v1.json'),
  });
}
