import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { loadBundle } from '../loader.ts';
import type { PtkgBundle } from '../types.ts';
import { loadProjectInput } from '../project/workspace.ts';
import type {
  CourseBlueprint,
  CourseCard,
  CourseCompileResult,
  CourseGate,
  CourseManifest,
  CoursePractice,
  CourseQuestion,
  CourseStage,
  CourseUnit,
} from './types.ts';
import {
  canonicalJson,
  canonicalJsonl,
  computeCourseChecksums,
  computeCourseContentHash,
  parseCard,
  readCourseJsonl,
  renderCard,
} from './io.ts';

const TOOL_VERSION = '0.4.0';

function withHash<T extends { content_hash: string }>(value: T): T {
  return { ...value, content_hash: computeCourseContentHash(value) };
}

function yaml(value: unknown): string {
  return YAML.stringify(value, { lineWidth: 0 });
}

async function ensureEmptyOutput(directory: string): Promise<void> {
  const info = await stat(directory).catch(() => null);
  if (!info) {
    await mkdir(directory, { recursive: true });
    return;
  }
  if (!info.isDirectory()) throw new Error(`课程包输出不是目录：${directory}`);
  const entries = await readdir(directory);
  if (entries.length > 0) throw new Error(`课程包输出目录必须为空：${directory}`);
}

async function write(root: string, relative: string, content: string | Uint8Array): Promise<void> {
  const full = path.join(root, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

async function readOptionalJsonl(root: string, relative: string): Promise<Record<string, unknown>[]> {
  const info = await stat(path.join(root, relative)).catch(() => null);
  if (!info?.isFile()) return [];
  return readCourseJsonl<Record<string, unknown>>(root, relative);
}

function canonicalRecords(values: Record<string, unknown>[]): string {
  const sorted = [...values].sort((a, b) => {
    const left = typeof a.id === 'string' ? a.id : canonicalJson(a);
    const right = typeof b.id === 'string' ? b.id : canonicalJson(b);
    return left.localeCompare(right);
  });
  return sorted.length === 0 ? '' : `${sorted.map(canonicalJson).join('\n')}\n`;
}

function localRepositoryIdentity(commit: string): string {
  return `local-git:${commit}`;
}

function redactKnownLocalRepository<T>(value: T, localPath: string, replacement: string): T {
  const windows = path.resolve(localPath);
  const slash = windows.replaceAll('\\', '/');
  function visit(item: unknown): unknown {
    if (typeof item === 'string') {
      if (item === localPath || item === windows || item === slash) return replacement;
      return item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        result[key] = visit(child);
      }
      return result;
    }
    return item;
  }
  return visit(value) as T;
}

async function loadCards(workspace: string): Promise<CourseCard[]> {
  const root = path.join(workspace, '09-course');
  const cardsDirectory = path.join(root, 'cards');
  const files = (await readdir(cardsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `cards/${entry.name}`)
    .sort();
  const cards: CourseCard[] = [];
  for (const file of files) {
    const parsed = parseCard(await readFile(path.join(root, file), 'utf8'), file);
    cards.push(withHash(parsed));
  }
  return cards.sort((a, b) => a.id.localeCompare(b.id));
}

function dreamProjection(input: {
  manifest: CourseManifest;
  bundle: PtkgBundle;
  stages: CourseStage[];
  units: CourseUnit[];
  questions: CourseQuestion[];
  practices: CoursePractice[];
  gates: CourseGate[];
  cards: CourseCard[];
}): Record<string, unknown> {
  return {
    contract: 'dream-agent-course-projection@1',
    course_id: input.manifest.course_id,
    version: input.manifest.version,
    stage_ids: input.stages.map((item) => item.id).sort(),
    unit_ids: input.units.map((item) => item.id).sort(),
    question_ids: input.questions.map((item) => item.id).sort(),
    practice_ids: input.practices.map((item) => item.id).sort(),
    gate_ids: input.gates.map((item) => item.id).sort(),
    card_ids: input.cards.map((item) => item.id).sort(),
    graph: {
      node_ids: input.bundle.nodes.map((item) => item.id).sort(),
      edge_ids: input.bundle.edges.map((item) => item.id).sort(),
      source_ids: input.bundle.sources.map((item) => item.id).sort(),
    },
  };
}

export async function compileCourse(workspace: string, output: string): Promise<CourseCompileResult> {
  const root = path.resolve(workspace);
  const destination = path.resolve(output);
  await ensureEmptyOutput(destination);

  const input = await loadProjectInput(root);
  const loaded = await loadBundle(path.join(root, '07-projection'));
  if (!loaded.bundle || loaded.findings.some((item) => item.severity === 'blocker')) {
    throw new Error(`PTKG projection 无法编译：${loaded.findings.map((item) => item.message).join('；')}`);
  }
  const blueprint = YAML.parse(
    await readFile(path.join(root, '09-course', 'blueprint.yaml'), 'utf8'),
  ) as CourseBlueprint;
  if (blueprint.spec_version !== 'course-blueprint@1') {
    throw new Error('09-course/blueprint.yaml 必须使用 course-blueprint@1。');
  }

  const repo = input.repository.kind === 'local'
    ? localRepositoryIdentity(input.repository.commit)
    : loaded.bundle.manifest.project_ref.repository_url;
  const bundle = input.repository.kind === 'local'
    ? redactKnownLocalRepository(loaded.bundle, input.repository.locator, repo)
    : loaded.bundle;
  const manifest: CourseManifest = {
    contract: 'os-camp-course@1',
    course_id: blueprint.course_id,
    version: blueprint.version,
    title: blueprint.title,
    language: blueprint.language,
    package_status: 'draft',
    curriculum_boundary: 'pre_project_readiness',
    project_ref: { repo, commit: input.repository.commit, tree: input.repository.tree },
    generator: { tool: '@os-camp/ptkg', version: TOOL_VERSION },
  };
  const stages = blueprint.stages.map((item) => withHash({ ...item, content_hash: '' }));
  const units = (await readCourseJsonl<CourseUnit>(root, '09-course/units.jsonl')).map(withHash);
  const questions = (await readCourseJsonl<CourseQuestion>(root, '09-course/questions.jsonl')).map(withHash);
  const practices = (await readCourseJsonl<CoursePractice>(root, '09-course/practices.jsonl')).map(withHash);
  const gates = (await readCourseJsonl<CourseGate>(root, '09-course/gates.jsonl')).map(withHash);
  const cards = await loadCards(root);
  const reviewEvents = await readOptionalJsonl(root, '08-governance/review-events.jsonl');

  await Promise.all([
    write(destination, 'manifest.yaml', yaml(manifest)),
    write(destination, 'graph/nodes.jsonl', canonicalJsonl(bundle.nodes)),
    write(destination, 'graph/edges.jsonl', canonicalJsonl(bundle.edges)),
    write(destination, 'graph/sources.jsonl', canonicalJsonl(bundle.sources)),
    write(destination, 'course/stages.jsonl', canonicalJsonl(stages)),
    write(destination, 'course/units.jsonl', canonicalJsonl(units)),
    write(destination, 'course/questions.jsonl', canonicalJsonl(questions)),
    write(destination, 'course/practices.jsonl', canonicalJsonl(practices)),
    write(destination, 'course/gates.jsonl', canonicalJsonl(gates)),
    write(destination, 'governance/review-events.jsonl', canonicalRecords(reviewEvents)),
    write(destination, 'governance/attestations.jsonl', ''),
    write(destination, 'projections/dream-agent-v1.json', `${canonicalJson(dreamProjection({
      manifest, bundle, stages, units, questions, practices, gates, cards,
    }))}\n`),
  ]);
  for (const card of cards) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(card.id)) throw new Error(`知识卡 ID 不能安全映射为文件名：${card.id}`);
    await write(destination, `content/cards/${card.id}.md`, renderCard(card));
  }
  const checksums = await computeCourseChecksums(destination);
  await write(destination, 'checksums.json', `${canonicalJson(checksums)}\n`);
  return {
    package_dir: destination,
    checksums,
    counts: {
      nodes: bundle.nodes.length,
      edges: bundle.edges.length,
      sources: bundle.sources.length,
      stages: stages.length,
      units: units.length,
      questions: questions.length,
      practices: practices.length,
      gates: gates.length,
      cards: cards.length,
    },
  };
}
