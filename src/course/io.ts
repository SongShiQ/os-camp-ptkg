import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import type {
  CourseAttestation,
  CourseCard,
  CourseChecksums,
  CourseFinding,
  CourseGate,
  CourseManifest,
  CoursePackage,
  CoursePractice,
  CourseQuestion,
  CourseStage,
  CourseUnit,
} from './types.ts';
import type { PtkgEdge, PtkgNode, PtkgSource } from '../types.ts';

export const REQUIRED_COURSE_FILES = [
  'manifest.yaml',
  'graph/nodes.jsonl',
  'graph/edges.jsonl',
  'graph/sources.jsonl',
  'course/stages.jsonl',
  'course/units.jsonl',
  'course/questions.jsonl',
  'course/practices.jsonl',
  'course/gates.jsonl',
  'governance/review-events.jsonl',
  'governance/attestations.jsonl',
  'projections/dream-agent-v1.json',
  'checksums.json',
] as const;

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON 不接受 NaN 或 Infinity。');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) result[key] = normalize(record[key]);
    }
    return result;
  }
  throw new Error(`canonical JSON 不支持 ${typeof value}。`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function canonicalJsonl(values: Array<{ id: string }>): string {
  const sorted = [...values].sort((a, b) => a.id.localeCompare(b.id));
  return sorted.length === 0 ? '' : `${sorted.map(canonicalJson).join('\n')}\n`;
}

export function computeCourseContentHash(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return sha256(canonicalJson(value));
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.content_hash;
  delete copy.file;
  return sha256(canonicalJson(copy));
}

export function safeCoursePath(relative: string): boolean {
  if (!relative || relative.includes('\\') || path.posix.isAbsolute(relative)) return false;
  const normalized = path.posix.normalize(relative);
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../') && normalized === relative;
}

export async function readCourseJsonl<T>(root: string, relative: string): Promise<T[]> {
  const text = await readFile(path.join(root, relative), 'utf8');
  const values: T[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    try {
      values.push(JSON.parse(trimmed) as T);
    } catch (error) {
      throw new Error(`${relative}:${index + 1} JSON 解析失败：${(error as Error).message}`);
    }
  }
  return values;
}

export function renderCard(card: Omit<CourseCard, 'file'>): string {
  const metadata = {
    id: card.id,
    title: card.title,
    unit_ids: card.unit_ids,
    node_ids: card.node_ids,
    source_refs: card.source_refs,
    status: card.status,
    generated_by: card.generated_by,
    content_hash: card.content_hash,
  };
  return `---\n${YAML.stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${card.body.trim()}\n`;
}

export function parseCard(text: string, file: string): CourseCard {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match?.[1]) throw new Error(`${file} 缺少 YAML front matter。`);
  const metadata = YAML.parse(match[1]) as Omit<CourseCard, 'body' | 'file'>;
  return { ...metadata, body: (match[2] ?? '').trim(), file };
}

export async function listCardFiles(root: string): Promise<string[]> {
  const cardsDir = path.join(root, 'content', 'cards');
  const info = await stat(cardsDir).catch(() => null);
  if (!info?.isDirectory()) return [];
  return (await readdir(cardsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `content/cards/${entry.name}`)
    .sort();
}

export async function listPackageFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`课程包不允许符号链接：${relative}`);
      if (entry.isDirectory()) await visit(full, relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  await visit(root, '');
  return files.sort();
}

export async function computeCourseChecksums(root: string): Promise<CourseChecksums> {
  const all = await listPackageFiles(root);
  const included = all.filter((file) => file !== 'checksums.json'
    && file !== 'governance/attestations.jsonl'
    && !file.endsWith('.tgz'));
  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const relative of included) {
    if (!safeCoursePath(relative)) throw new Error(`不安全的课程包路径：${relative}`);
    const bytes = await readFile(path.join(root, relative));
    files.push({ path: relative, sha256: sha256(bytes), bytes: bytes.byteLength });
  }
  const rootHash = sha256(`os-camp-course@1\0${canonicalJson(files)}`);
  return { contract: 'os-camp-course-checksums@1', algorithm: 'sha256', files, root_hash: rootHash };
}

function loadFinding(message: string, file = 'manifest.yaml'): CourseFinding {
  return { code: 'COURSE001', severity: 'blocker', subject: file, file, message };
}

export async function loadCoursePackage(root: string): Promise<{ package: CoursePackage | null; findings: CourseFinding[] }> {
  const absolute = path.resolve(root);
  const missing: CourseFinding[] = [];
  for (const file of REQUIRED_COURSE_FILES) {
    if (!await stat(path.join(absolute, file)).catch(() => null)) missing.push(loadFinding(`缺少必需文件 ${file}。`, file));
  }
  if (missing.length > 0) return { package: null, findings: missing };
  try {
    const manifest = YAML.parse(await readFile(path.join(absolute, 'manifest.yaml'), 'utf8')) as CourseManifest;
    const cardFiles = await listCardFiles(absolute);
    const cards: CourseCard[] = [];
    for (const file of cardFiles) cards.push(parseCard(await readFile(path.join(absolute, file), 'utf8'), file));
    const checksums = JSON.parse(await readFile(path.join(absolute, 'checksums.json'), 'utf8')) as CourseChecksums;
    const projection = JSON.parse(await readFile(path.join(absolute, 'projections', 'dream-agent-v1.json'), 'utf8')) as Record<string, unknown>;
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
        practices: await readCourseJsonl<CoursePractice>(absolute, 'course/practices.jsonl'),
        gates: await readCourseJsonl<CourseGate>(absolute, 'course/gates.jsonl'),
        cards,
        attestations: await readCourseJsonl<CourseAttestation>(absolute, 'governance/attestations.jsonl'),
        checksums,
        dreamProjection: projection,
      },
      findings: [],
    };
  } catch (error) {
    return { package: null, findings: [loadFinding((error as Error).message)] };
  }
}
