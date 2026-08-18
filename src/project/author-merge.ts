import { lstat, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { computeContentHash } from '../authoring/hash.ts';
import { atomicWriteFile, withWorkspaceLease } from '../io/atomic.ts';
import { compareCanonicalString } from '../io/stable.ts';
import { verifyShardSeal, type AgentShardSeal } from './shard-output.ts';
import { canonicalJson, parseCard, safeCoursePath, sha256 } from '../course/io.ts';
import {
  PARALLEL_CHECKPOINTS,
  SHARD_MERGE_JSONL_PATHS,
  type AgentShardManifest,
  type AgentTaskPlan,
  type ParallelCheckpointId,
  type ShardMergeDisposition,
  type ShardMergeItem,
  type ShardMergeJsonlPath,
  type ShardMergeReport,
} from './shard-types.ts';
import { computeAuthoringShardInputHash, loadAuthoringScopeGroups, loadShardWorkspaceIdentity } from './task-split.ts';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const CARD_GLOB = '09-course/cards/*.md' as const;

export interface MergeAuthoringShardOptions {
  write?: boolean;
  now?: string;
}

interface ValidShard {
  id: string;
  root: string;
  outputRoot: string;
  manifest: AgentShardManifest;
  seal: AgentShardSeal;
}

interface JsonObjectEntry {
  id: string;
  object: Record<string, unknown>;
  hash: string;
  shardId: string;
}

interface CardEntry {
  id: string;
  relative: string;
  text: string;
  hash: string;
  shardId: string;
}

interface PreparedWrite {
  relative: string;
  data: string;
  expected_hash: string | null;
}

function item(
  shardId: string,
  relative: string,
  disposition: ShardMergeDisposition,
  reason: string,
  extra: Partial<ShardMergeItem> = {},
): ShardMergeItem {
  return { shard_id: shardId, path: relative, disposition, reason, ...extra };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function allowedForCheckpoint(checkpoint: ParallelCheckpointId, relative: string): boolean {
  return checkpoint === 'competency_evidence'
    ? relative === '04-behaviors/behavior-chains.jsonl' || relative === '05-slices/learning-slices.jsonl'
    : relative === '09-course/questions.jsonl' || relative === '09-course/practices.jsonl';
}

function parseManifest(raw: string, directoryName: string): AgentShardManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`manifest.json 解析失败：${(error as Error).message}`);
  }
  if (!isRecord(value)) throw new Error('manifest.json 根节点必须是对象。');
  if (
    value.spec_version !== 'ptkg-agent-shard@1'
    || typeof value.shard_id !== 'string'
    || value.shard_id !== directoryName
    || typeof value.workspace_id !== 'string'
    || !(PARALLEL_CHECKPOINTS as readonly unknown[]).includes(value.checkpoint)
    || typeof value.input_hash !== 'string'
    || !SHA64.test(value.input_hash)
    || !isRecord(value.source)
    || !SHA40.test(String(value.source.commit ?? ''))
    || !SHA40.test(String(value.source.tree ?? ''))
    || !['coverage_unit', 'course_unit'].includes(String(value.scope_kind ?? ''))
    || !Array.isArray(value.scope_ids)
    || value.scope_ids.length === 0
    || value.scope_ids.some((entry) => typeof entry !== 'string' || !entry)
    || value.output_root !== 'agent-workspace/output'
    || !Array.isArray(value.allowed_jsonl_paths)
    || value.allowed_jsonl_paths.some((entry) => !(SHARD_MERGE_JSONL_PATHS as readonly unknown[]).includes(entry))
    || (value.allowed_card_glob !== null && value.allowed_card_glob !== CARD_GLOB)
    || !['candidate', 'unresolved'].includes(String(value.status ?? ''))
    || typeof value.created_at !== 'string'
  ) {
    throw new Error('manifest.json 不符合 ptkg-agent-shard@1。');
  }
  const manifest = value as unknown as AgentShardManifest;
  if (
    (manifest.checkpoint === 'competency_evidence' && manifest.scope_kind !== 'coverage_unit')
    || (manifest.checkpoint === 'course_assets' && manifest.scope_kind !== 'course_unit')
  ) throw new Error('manifest scope_kind 与 checkpoint 不一致。');
  if (new Set(manifest.scope_ids).size !== manifest.scope_ids.length) {
    throw new Error('scope_ids 不得重复。');
  }
  if (new Set(manifest.allowed_jsonl_paths).size !== manifest.allowed_jsonl_paths.length) {
    throw new Error('allowed_jsonl_paths 不得重复。');
  }
  if (manifest.allowed_jsonl_paths.some((relative) => !safeCoursePath(relative) || !allowedForCheckpoint(manifest.checkpoint, relative))) {
    throw new Error('allowed_jsonl_paths 包含越界或不属于当前 checkpoint 的路径。');
  }
  if (manifest.checkpoint === 'competency_evidence' && manifest.allowed_card_glob !== null) {
    throw new Error('competency_evidence shard 不允许写课程卡片。');
  }
  if (manifest.checkpoint === 'course_assets' && manifest.allowed_card_glob !== CARD_GLOB) {
    throw new Error('course_assets shard 必须显式声明 cards 白名单。');
  }
  return manifest;
}

function parseTaskPlan(raw: string): AgentTaskPlan {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`task-plan.json 解析失败：${(error as Error).message}`);
  }
  if (!isRecord(value)) throw new Error('task-plan.json 根节点必须是对象。');
  if (
    value.spec_version !== 'ptkg-agent-task-plan@1'
    || typeof value.workspace_id !== 'string'
    || !(PARALLEL_CHECKPOINTS as readonly unknown[]).includes(value.checkpoint)
    || typeof value.input_hash !== 'string'
    || !SHA64.test(value.input_hash)
    || !isRecord(value.source)
    || !SHA40.test(String(value.source.commit ?? ''))
    || !SHA40.test(String(value.source.tree ?? ''))
    || !Array.isArray(value.shards)
    || value.shards.length === 0
    || value.shards.some((entry) => (
      !isRecord(entry)
      || typeof entry.shard_id !== 'string'
      || !/^[a-z0-9._-]+$/i.test(entry.shard_id)
      || !['coverage_unit', 'course_unit'].includes(String(entry.scope_kind ?? ''))
      || !Array.isArray(entry.scope_ids)
      || entry.scope_ids.length === 0
      || entry.scope_ids.some((id) => typeof id !== 'string' || !id)
      || new Set(entry.scope_ids).size !== entry.scope_ids.length
      || typeof entry.manifest_hash !== 'string'
      || !SHA64.test(entry.manifest_hash)
    ))
    || !['active', 'merged'].includes(String(value.state ?? ''))
    || typeof value.created_at !== 'string'
  ) {
    throw new Error('task-plan.json 不符合 ptkg-agent-task-plan@1。');
  }
  const plan = value as unknown as AgentTaskPlan;
  const shardIds = plan.shards.map((entry) => entry.shard_id);
  if (new Set(shardIds).size !== shardIds.length) throw new Error('task-plan.json 含重复 shard id。');
  const claims = plan.shards.flatMap((entry) => entry.scope_ids);
  if (new Set(claims).size !== claims.length) throw new Error('task-plan.json 含重复 scope claim。');
  return plan;
}

async function assertPlainDirectory(directory: string, label: string): Promise<void> {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) throw new Error(`${label} 不允许符号链接。`);
  if (!info.isDirectory()) throw new Error(`${label} 必须是目录。`);
}

async function listOutputFiles(root: string): Promise<{ files: string[]; rejected: string[] }> {
  const files: string[] = [];
  const rejected: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compareCanonicalString(a.name, b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        rejected.push(relative);
      } else if (info.isDirectory()) {
        await visit(full, relative);
      } else if (info.isFile()) {
        files.push(relative);
      } else {
        rejected.push(relative);
      }
    }
  }
  await visit(root, '');
  return { files: files.sort(), rejected: rejected.sort() };
}

function isAllowedCard(relative: string, manifest: AgentShardManifest): boolean {
  return manifest.allowed_card_glob === CARD_GLOB
    && /^09-course\/cards\/[^/]+\.md$/.test(relative)
    && safeCoursePath(relative);
}

function validateAuthority(object: Record<string, unknown>): string | null {
  if ('status' in object && !['candidate', 'unresolved'].includes(String(object.status))) {
    return `Agent 对象 status 只能是 candidate/unresolved，收到 ${String(object.status)}。`;
  }
  const approval = object.approval;
  if (isRecord(approval) && ['approved', 'published'].includes(String(approval.status ?? ''))) {
    return 'Agent 分片不得创建 approved/published approval。';
  }
  return null;
}

function validateCoverageOwnership(
  object: Record<string, unknown>,
  manifest: AgentShardManifest,
): string | null {
  const refs = manifest.scope_kind === 'coverage_unit' ? object.coverage_refs : object.unit_ids;
  if (!Array.isArray(refs) || refs.length === 0 || refs.some((entry) => typeof entry !== 'string')) {
    return manifest.scope_kind === 'coverage_unit'
      ? 'behavior/slice 必须声明非空 coverage_refs。'
      : 'course asset 必须声明非空 unit_ids。';
  }
  if (manifest.scope_kind === 'course_unit' && refs.length !== 1) return 'course asset 只能绑定一个 course unit。';
  const outside = refs.filter((entry) => !manifest.scope_ids.includes(entry as string));
  return outside.length > 0 ? `对象越过 shard scope claim：${outside.join(', ')}` : null;
}

function parseJsonl(text: string, relative: string): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`${relative}:${index + 1} JSON 解析失败：${(error as Error).message}`);
    }
    if (!isRecord(value)) throw new Error(`${relative}:${index + 1} 必须是 JSON 对象。`);
    if (typeof value.id !== 'string' || !value.id.trim()) throw new Error(`${relative}:${index + 1} 缺少稳定 id。`);
    const authority = validateAuthority(value);
    if (authority) throw new Error(`${relative}:${index + 1} ${authority}`);
    values.push(value);
  }
  return values;
}

function canonicalJsonl(entries: Iterable<JsonObjectEntry>): string {
  const values = [...entries].sort((left, right) => compareCanonicalString(left.id, right.id));
  return values.length === 0 ? '' : `${values.map((entry) => canonicalJson(entry.object)).join('\n')}\n`;
}

async function loadCanonicalJsonl(workspace: string, relative: string): Promise<Map<string, JsonObjectEntry>> {
  const result = new Map<string, JsonObjectEntry>();
  const file = path.join(workspace, ...relative.split('/'));
  const info = await stat(file).catch(() => null);
  if (!info) return result;
  const values = parseJsonl(await readFile(file, 'utf8'), relative);
  for (const object of values) {
    const id = object.id as string;
    if (result.has(id)) throw new Error(`canonical ${relative} 含重复 id：${id}`);
    result.set(id, { id, object, hash: computeContentHash(object), shardId: 'canonical' });
  }
  return result;
}

function normalizeCardText(text: string): string {
  return `${text.replace(/\r\n?/g, '\n').trimEnd()}\n`;
}

async function loadCanonicalCards(workspace: string): Promise<Map<string, CardEntry>> {
  const result = new Map<string, CardEntry>();
  const directory = path.join(workspace, '09-course', 'cards');
  const info = await stat(directory).catch(() => null);
  if (!info) return result;
  await assertPlainDirectory(directory, 'canonical cards');
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compareCanonicalString(a.name, b.name))) {
    const full = path.join(directory, entry.name);
    const fileInfo = await lstat(full);
    if (fileInfo.isSymbolicLink()) throw new Error(`canonical card 不允许符号链接：${entry.name}`);
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const relative = `09-course/cards/${entry.name}`;
    const text = normalizeCardText(await readFile(full, 'utf8'));
    const card = parseCard(text, relative);
    if (typeof card.id !== 'string' || !card.id) throw new Error(`canonical card 缺少稳定 id：${relative}`);
    if (result.has(card.id)) throw new Error(`canonical cards 含重复 id：${card.id}`);
    result.set(card.id, { id: card.id, relative, text, hash: sha256(text), shardId: 'canonical' });
  }
  return result;
}

async function noSymlinkComponents(workspace: string, target: string): Promise<boolean> {
  const relative = path.relative(workspace, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  let current = workspace;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return true;
    if (info.isSymbolicLink()) return false;
  }
  return true;
}

function summarize(items: ShardMergeItem[]): Record<ShardMergeDisposition, number> {
  const result: Record<ShardMergeDisposition, number> = {
    accepted: 0,
    duplicate: 0,
    conflict: 0,
    stale: 0,
    rejected: 0,
  };
  for (const entry of items) result[entry.disposition]++;
  return result;
}

function sortItems(items: ShardMergeItem[]): ShardMergeItem[] {
  return [...items].sort((left, right) =>
    compareCanonicalString(left.shard_id, right.shard_id)
    || compareCanonicalString(left.path, right.path)
    || compareCanonicalString(String(left.object_id ?? ''), String(right.object_id ?? ''))
    || compareCanonicalString(left.disposition, right.disposition));
}

async function transactionalWrites(workspace: string, writes: PreparedWrite[], report: ShardMergeReport): Promise<void> {
  const originals = new Map<string, Buffer | null>();
  const completed: string[] = [];
  try {
    for (const write of writes) {
      const target = path.join(workspace, ...write.relative.split('/'));
      const original = await readFile(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      const currentHash = original === null ? null : sha256(original);
      if (currentHash !== write.expected_hash) {
        throw new Error(`canonical 文件在 dry-run 后发生变化：${write.relative}`);
      }
      originals.set(write.relative, original);
      await atomicWriteFile(target, write.data);
      completed.push(write.relative);
    }
    await atomicWriteFile(
      path.join(workspace, '.ptkg', 'coordination', 'merge-report.json'),
      `${canonicalJson(report)}\n`,
    );
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const relative of completed.reverse()) {
      const target = path.join(workspace, ...relative.split('/'));
      try {
        const original = originals.get(relative);
        if (original === null) await rm(target, { force: true });
        else if (original) await atomicWriteFile(target, original);
      } catch (rollbackError) {
        rollbackErrors.push(`${relative}: ${(rollbackError as Error).message}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`合并失败且回滚不完整：${(error as Error).message}；${rollbackErrors.join('；')}`);
    }
    throw error;
  }
}

export async function mergeAuthoringShards(
  workspace: string,
  options: MergeAuthoringShardOptions = {},
): Promise<ShardMergeReport> {
  const root = path.resolve(workspace);
  const shardsRoot = path.join(root, '.ptkg', 'shards');
  const identity = await loadShardWorkspaceIdentity(root);
  if (!await noSymlinkComponents(root, shardsRoot)) throw new Error('shards root 路径包含符号链接或越界。');
  await assertPlainDirectory(shardsRoot, 'shards root');

  const taskPlanFile = path.join(root, '.ptkg', 'coordination', 'task-plan.json');
  if (!await noSymlinkComponents(root, taskPlanFile)) throw new Error('task-plan 路径包含符号链接或越界。');
  const taskPlanInfo = await lstat(taskPlanFile);
  if (taskPlanInfo.isSymbolicLink() || !taskPlanInfo.isFile()) {
    throw new Error('task-plan.json 必须是普通文件。');
  }
  const taskPlan = parseTaskPlan(await readFile(taskPlanFile, 'utf8'));
  if (
    taskPlan.workspace_id !== identity.workspace_id
    || taskPlan.source.commit !== identity.commit
    || taskPlan.source.tree !== identity.tree
  ) {
    throw new Error('task-plan 与当前 workspace_id/commit/tree 不一致。');
  }
  const scope = await loadAuthoringScopeGroups(root, taskPlan.checkpoint);
  if (taskPlan.shards.some((entry) => entry.scope_kind !== scope.kind)) {
    throw new Error('task-plan scope_kind 与当前 checkpoint 不一致。');
  }
  const plannedClaims = taskPlan.shards.flatMap((entry) => entry.scope_ids).sort(compareCanonicalString);
  const requiredClaims = scope.groups.flatMap((group) => group).sort(compareCanonicalString);
  if (canonicalJson(plannedClaims) !== canonicalJson(requiredClaims)) {
    throw new Error('task-plan coverage 分配不是 required units 的完整精确分区。');
  }
  for (const group of scope.groups) {
    const owners = taskPlan.shards.filter((entry) => group.some((id) => entry.scope_ids.includes(id)));
    if (owners.length !== 1 || group.some((id) => !owners[0]?.scope_ids.includes(id))) {
      throw new Error(`task-plan 拆散了不可分割的 scope group：${group.join(', ')}`);
    }
  }

  const items: ShardMergeItem[] = [];
  const valid: ValidShard[] = [];
  const shardIds: string[] = [];
  const currentInputHash = await computeAuthoringShardInputHash(root, taskPlan.checkpoint);
  const entries = taskPlan.shards.map((assignment) => ({ name: assignment.shard_id, assignment }));

  for (const entry of entries) {
    shardIds.push(entry.name);
    const shardRoot = path.join(shardsRoot, entry.name);
    const entryInfo = await lstat(shardRoot);
    if (entryInfo.isSymbolicLink() || !entryInfo.isDirectory()) {
      items.push(item(entry.name, '.', 'rejected', 'shard 必须是普通目录，不能是符号链接。'));
      continue;
    }
    let manifest: AgentShardManifest;
    try {
      const manifestFile = path.join(shardRoot, 'manifest.json');
      const manifestInfo = await lstat(manifestFile);
      if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new Error('manifest.json 必须是普通文件。');
      manifest = parseManifest(await readFile(manifestFile, 'utf8'), entry.name);
    } catch (error) {
      items.push(item(entry.name, 'manifest.json', 'rejected', (error as Error).message));
      continue;
    }
    if (
      manifest.workspace_id !== identity.workspace_id
      || manifest.source.commit !== identity.commit
      || manifest.source.tree !== identity.tree
      || manifest.checkpoint !== taskPlan.checkpoint
      || manifest.input_hash !== taskPlan.input_hash
      || manifest.scope_kind !== entry.assignment.scope_kind
      || canonicalJson(manifest.scope_ids) !== canonicalJson(entry.assignment.scope_ids)
      || sha256(canonicalJson(manifest)) !== entry.assignment.manifest_hash
    ) {
      items.push(item(entry.name, 'manifest.json', 'stale', 'manifest 与活动 task plan 或固定源码身份不一致。'));
      continue;
    }
    if (manifest.input_hash !== currentInputHash) {
      items.push(item(entry.name, 'manifest.json', 'stale', 'input_hash 与当前只读上游输入不一致。', {
        canonical_hash: currentInputHash,
        shard_hash: manifest.input_hash,
      }));
      continue;
    }
    const requiredIds = new Set(requiredClaims);
    const invalidClaims = manifest.scope_ids.filter((id) => !requiredIds.has(id));
    if (invalidClaims.length > 0) {
      items.push(item(entry.name, 'manifest.json', 'rejected', `声明了非 required scope：${invalidClaims.join(', ')}`));
      continue;
    }
    const outputRoot = path.join(shardRoot, ...manifest.output_root.split('/'));
    if (path.dirname(path.dirname(outputRoot)) !== shardRoot) {
      items.push(item(entry.name, 'manifest.json', 'rejected', 'output_root 路径越界。'));
      continue;
    }
    try {
      await assertPlainDirectory(outputRoot, 'shard output');
    } catch (error) {
      items.push(item(entry.name, 'output', 'rejected', (error as Error).message));
      continue;
    }
    const seal = await verifyShardSeal(
      outputRoot,
      path.join(shardRoot, 'seal.json'),
      entry.name,
      entry.assignment.manifest_hash,
    );
    if (!seal.valid) {
      items.push(item(entry.name, 'seal.json', 'rejected', seal.reason));
      continue;
    }
    valid.push({ id: entry.name, root: shardRoot, outputRoot, manifest, seal: seal.seal });
  }

  const claimed = new Map<string, string>();
  const mergeable: ValidShard[] = [];
  for (const shard of valid) {
    const overlaps = shard.manifest.scope_ids
      .map((id) => ({ id, owner: claimed.get(`${shard.manifest.scope_kind}:${id}`) }))
      .filter((entry): entry is { id: string; owner: string } => Boolean(entry.owner));
    if (overlaps.length > 0) {
      items.push(item(shard.id, 'manifest.json', 'rejected', `scope claim 与其他 shard 重叠：${overlaps.map((entry) => `${entry.id} (${entry.owner})`).join(', ')}`));
      continue;
    }
    for (const id of shard.manifest.scope_ids) claimed.set(`${shard.manifest.scope_kind}:${id}`, shard.id);
    mergeable.push(shard);
  }

  const jsonMaps = new Map<string, Map<string, JsonObjectEntry>>();
  const touchedJsonPaths = new Set<string>();
  const cards = await loadCanonicalCards(root);
  const cardPathOwners = new Map([...cards.values()].map((entry) => [entry.relative, entry.id]));
  const newCards = new Map<string, CardEntry>();

  for (const shard of mergeable) {
    const listed = await listOutputFiles(shard.outputRoot);
    for (const relative of listed.rejected) {
      items.push(item(shard.id, relative, 'rejected', 'output 不允许符号链接或特殊文件。'));
    }
    if (listed.files.length === 0 && listed.rejected.length === 0) {
      items.push(item(shard.id, 'output', 'rejected', 'shard output 为空。'));
      continue;
    }
    for (const relative of listed.files) {
      if (!safeCoursePath(relative)) {
        items.push(item(shard.id, relative, 'rejected', 'output 路径不安全。'));
        continue;
      }
      const isJsonl = shard.manifest.allowed_jsonl_paths.includes(relative as ShardMergeJsonlPath);
      const isCard = isAllowedCard(relative, shard.manifest);
      if (!isJsonl && !isCard) {
        items.push(item(shard.id, relative, 'rejected', '文件不在 shard manifest 白名单中。'));
        continue;
      }
      const full = path.join(shard.outputRoot, ...relative.split('/'));
      if (!await noSymlinkComponents(shard.outputRoot, full)) {
        items.push(item(shard.id, relative, 'rejected', 'output 路径包含符号链接或越界。'));
        continue;
      }
      if (isJsonl) {
        let objects: Record<string, unknown>[];
        try {
          objects = parseJsonl(await readFile(full, 'utf8'), relative);
        } catch (error) {
          items.push(item(shard.id, relative, 'rejected', (error as Error).message));
          continue;
        }
        if (objects.length === 0) {
          items.push(item(shard.id, relative, 'rejected', 'JSONL 分片文件不能为空；没有对象时应省略该文件。'));
          continue;
        }
        let canonical = jsonMaps.get(relative);
        if (!canonical) {
          try {
            canonical = await loadCanonicalJsonl(root, relative);
            jsonMaps.set(relative, canonical);
          } catch (error) {
            items.push(item('canonical', relative, 'rejected', (error as Error).message));
            continue;
          }
        }
        touchedJsonPaths.add(relative);
        for (const object of objects) {
          const id = object.id as string;
          const ownership = validateCoverageOwnership(object, shard.manifest);
          if (ownership) {
            items.push(item(shard.id, relative, 'rejected', ownership, { object_id: id }));
            continue;
          }
          const hash = computeContentHash(object);
          const existing = canonical.get(id);
          if (!existing) {
            canonical.set(id, { id, object, hash, shardId: shard.id });
            items.push(item(shard.id, relative, 'accepted', '新增稳定 ID。', { object_id: id, shard_hash: hash }));
          } else if (existing.hash === hash) {
            items.push(item(shard.id, relative, 'duplicate', `与 ${existing.shardId} 的规范化内容一致。`, {
              object_id: id,
              canonical_hash: existing.hash,
              shard_hash: hash,
            }));
          } else {
            items.push(item(shard.id, relative, 'conflict', `与 ${existing.shardId} 的同 ID 内容不同。`, {
              object_id: id,
              canonical_hash: existing.hash,
              shard_hash: hash,
            }));
          }
        }
      } else {
        let text: string;
        let id: string | undefined;
        try {
          text = normalizeCardText(await readFile(full, 'utf8'));
          const parsed = parseCard(text, relative);
          id = parsed.id;
          if (!id) throw new Error('card 缺少稳定 id。');
          if (!['candidate', 'unresolved'].includes(String(parsed.status))) {
            throw new Error('card status 只能是 candidate/unresolved。');
          }
          const ownership = validateCoverageOwnership(parsed as unknown as Record<string, unknown>, shard.manifest);
          if (ownership) throw new Error(ownership);
        } catch (error) {
          items.push(item(shard.id, relative, 'rejected', (error as Error).message, id ? { object_id: id } : {}));
          continue;
        }
        const hash = sha256(text);
        const existing = cards.get(id) ?? newCards.get(id);
        const pathOwner = cardPathOwners.get(relative);
        if (pathOwner && pathOwner !== id) {
          items.push(item(shard.id, relative, 'conflict', `文件路径已由 card ${pathOwner} 使用。`, { object_id: id, shard_hash: hash }));
        } else if (!existing) {
          const entry: CardEntry = { id, relative, text, hash, shardId: shard.id };
          newCards.set(id, entry);
          cardPathOwners.set(relative, id);
          items.push(item(shard.id, relative, 'accepted', '新增稳定 card ID。', { object_id: id, shard_hash: hash }));
        } else if (existing.hash === hash) {
          items.push(item(shard.id, relative, 'duplicate', `与 ${existing.shardId} 的 card 内容一致。`, {
            object_id: id,
            canonical_hash: existing.hash,
            shard_hash: hash,
          }));
        } else {
          items.push(item(shard.id, relative, 'conflict', `与 ${existing.shardId} 的同 ID card 内容不同。`, {
            object_id: id,
            canonical_hash: existing.hash,
            shard_hash: hash,
          }));
        }
      }
    }
  }

  const sortedItems = sortItems(items);
  const summary = summarize(sortedItems);
  const blocked = summary.conflict + summary.stale + summary.rejected > 0;
  const writes: PreparedWrite[] = [];
  if (!blocked) {
    for (const relative of [...touchedJsonPaths].sort()) {
      const entriesForPath = jsonMaps.get(relative);
      if (entriesForPath) {
        const current = await readFile(path.join(root, ...relative.split('/'))).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        writes.push({
          relative,
          data: canonicalJsonl(entriesForPath.values()),
          expected_hash: current === null ? null : sha256(current),
        });
      }
    }
    for (const card of [...newCards.values()].sort((left, right) => compareCanonicalString(left.relative, right.relative))) {
      const current = await readFile(path.join(root, ...card.relative.split('/'))).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      writes.push({
        relative: card.relative,
        data: card.text,
        expected_hash: current === null ? null : sha256(current),
      });
    }
    for (const write of writes) {
      const target = path.join(root, ...write.relative.split('/'));
      if (!await noSymlinkComponents(root, target)) {
        sortedItems.push(item('canonical', write.relative, 'rejected', 'canonical 写入路径包含符号链接或越界。'));
      }
    }
  }

  let finalItems = sortItems(sortedItems);
  let finalSummary = summarize(finalItems);
  const canApply = finalSummary.conflict + finalSummary.stale + finalSummary.rejected === 0;
  const report: ShardMergeReport = {
    spec_version: 'ptkg-agent-merge-report@1',
    workspace_id: identity.workspace_id,
    input_hash: taskPlan.input_hash,
    dry_run: options.write !== true,
    applied: false,
    shard_ids: [...new Set(shardIds)].sort(),
    summary: finalSummary,
    items: finalItems,
    written_paths: [],
    sealed_shards: mergeable.map((shard) => ({
      shard_id: shard.id,
      manifest_hash: sha256(canonicalJson(shard.manifest)),
      output_hash: shard.seal.output_hash,
    })).sort((left, right) => compareCanonicalString(left.shard_id, right.shard_id)),
  };

  if (options.write === true) {
    const coordinatorLock = path.join(root, '.ptkg', 'locks', 'authoring-coordinator.lock');
    if (!await noSymlinkComponents(root, path.dirname(coordinatorLock))) {
      throw new Error('协调器 lock 路径包含符号链接或越界。');
    }
    if (canApply) {
      report.applied = true;
      report.written_paths = writes.map((entry) => entry.relative).sort();
    }
    await withWorkspaceLease(
      coordinatorLock,
      { owner: `author-merge:${process.pid}`, ttlMs: 30 * 60_000 },
      async () => {
        const lockedPlan = parseTaskPlan(await readFile(taskPlanFile, 'utf8'));
        if (
          lockedPlan.workspace_id !== taskPlan.workspace_id
          || lockedPlan.checkpoint !== taskPlan.checkpoint
          || lockedPlan.input_hash !== taskPlan.input_hash
          || lockedPlan.source.commit !== taskPlan.source.commit
          || lockedPlan.source.tree !== taskPlan.source.tree
          || canonicalJson(lockedPlan.shards) !== canonicalJson(taskPlan.shards)
        ) {
          throw new Error('活动 task plan 在 merge dry-run 后发生变化，请重新运行 author-merge。');
        }
        if (await computeAuthoringShardInputHash(root, lockedPlan.checkpoint) !== currentInputHash) {
          throw new Error('只读上游输入在 merge dry-run 后发生变化，请重新运行 author-merge。');
        }
        for (const shard of mergeable) {
          const manifestRaw = await readFile(path.join(shard.root, 'manifest.json'), 'utf8');
          const manifestHash = sha256(canonicalJson(JSON.parse(manifestRaw) as AgentShardManifest));
          const assignment = lockedPlan.shards.find((entry) => entry.shard_id === shard.id);
          if (!assignment || assignment.manifest_hash !== manifestHash) {
            throw new Error(`shard ${shard.id} manifest 在写入前发生变化，请重新封存。`);
          }
          const verified = await verifyShardSeal(shard.outputRoot, path.join(shard.root, 'seal.json'), shard.id, manifestHash);
          if (!verified.valid || verified.seal.output_hash !== shard.seal.output_hash) {
            throw new Error(`shard ${shard.id} seal/output 在写入前发生变化，请重新封存。`);
          }
        }
        if (canApply) {
          await transactionalWrites(root, writes, report);
          await atomicWriteFile(
            taskPlanFile,
            `${canonicalJson({ ...lockedPlan, state: 'merged' })}\n`,
          );
        }
        else {
          await mkdir(path.join(root, '.ptkg', 'coordination'), { recursive: true });
          await atomicWriteFile(
            path.join(root, '.ptkg', 'coordination', 'merge-report.json'),
            `${canonicalJson(report)}\n`,
          );
        }
      },
    );
  }

  return report;
}
