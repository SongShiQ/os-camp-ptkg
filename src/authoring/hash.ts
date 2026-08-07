import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { loadAuthoringRun } from './loader.ts';
import type { AuthoringObject } from './types.ts';

const EXCLUDED_TOP_LEVEL_FIELDS = new Set(['content_hash', 'created_at']);

function normalize(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('规范化 JSON 不接受 NaN 或 Infinity。');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, depth + 1));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (depth === 0 && EXCLUDED_TOP_LEVEL_FIELDS.has(key)) continue;
      const item = record[key];
      if (item !== undefined) normalized[key] = normalize(item, depth + 1);
    }
    return normalized;
  }
  throw new Error(`规范化 JSON 不支持 ${typeof value}。`);
}

/** 递归排序对象键、保留数组顺序，并排除顶层易变字段。 */
export function canonicalizeAuthoringObject(value: unknown): string {
  return JSON.stringify(normalize(value, 0));
}

export function computeContentHash(value: unknown): string {
  return createHash('sha256').update(canonicalizeAuthoringObject(value), 'utf8').digest('hex');
}

export interface HashEntry {
  id: string;
  stored: string;
  computed: string;
  matches: boolean;
}

function allObjects(run: Awaited<ReturnType<typeof loadAuthoringRun>>['run']): AuthoringObject[] {
  if (!run) return [];
  return [
    run.sourceContract,
    ...run.codeFacts,
    run.projectCoverage,
    ...run.behaviorChains,
    ...run.learningSlices,
    ...run.executionResults,
  ];
}

export async function inspectAuthoringHashes(dir: string): Promise<HashEntry[]> {
  const loaded = await loadAuthoringRun(dir);
  if (!loaded.run) {
    throw new Error(`无法载入作者运行：${loaded.findings.map((item) => item.message).join('；')}`);
  }
  return allObjects(loaded.run)
    .map((object) => {
      const computed = computeContentHash(object);
      return {
        id: String(object.id ?? '(missing-id)'),
        stored: typeof object.content_hash === 'string' ? object.content_hash : '',
        computed,
        matches: object.content_hash === computed,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function withHash(object: AuthoringObject): AuthoringObject {
  return { ...object, content_hash: computeContentHash(object) };
}

function jsonl(objects: AuthoringObject[]): string {
  return `${objects.map((object) => JSON.stringify(withHash(object))).join('\n')}\n`;
}

/** 回写六类带 envelope 的契约；治理事件保持 append-only，不在此改写。 */
export async function writeAuthoringHashes(dir: string): Promise<HashEntry[]> {
  const loaded = await loadAuthoringRun(dir);
  if (!loaded.run) {
    throw new Error(`无法载入作者运行：${loaded.findings.map((item) => item.message).join('；')}`);
  }
  const run = loaded.run;
  await Promise.all([
    writeFile(
      path.join(dir, run.origin.sourceContract),
      YAML.stringify(withHash(run.sourceContract), { lineWidth: 0 }),
      'utf8',
    ),
    writeFile(path.join(dir, run.origin.codeFacts), jsonl(run.codeFacts), 'utf8'),
    writeFile(
      path.join(dir, run.origin.projectCoverage),
      YAML.stringify(withHash(run.projectCoverage), { lineWidth: 0 }),
      'utf8',
    ),
    writeFile(path.join(dir, run.origin.behaviorChains), jsonl(run.behaviorChains), 'utf8'),
    writeFile(path.join(dir, run.origin.learningSlices), jsonl(run.learningSlices), 'utf8'),
    writeFile(path.join(dir, run.origin.executionResults), jsonl(run.executionResults), 'utf8'),
  ]);
  return inspectAuthoringHashes(dir);
}
