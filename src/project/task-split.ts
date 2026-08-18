import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { canonicalJson, sha256 } from '../course/io.ts';
import { atomicWriteFile, withWorkspaceLease } from '../io/atomic.ts';
import { compareCanonicalString } from '../io/stable.ts';
import { getProjectStatus } from './status.ts';
import {
  PARALLEL_CHECKPOINTS,
  SHARD_MERGE_JSONL_PATHS,
  type AgentShardManifest,
  type AgentTaskPlan,
  type ParallelCheckpointId,
  type ShardMergeJsonlPath,
} from './shard-types.ts';
import type { ProjectInput } from './types.ts';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;

const COMPETENCY_PATHS = [
  '04-behaviors/behavior-chains.jsonl',
  '05-slices/learning-slices.jsonl',
] as const satisfies readonly ShardMergeJsonlPath[];

const COURSE_PATHS = [
  '09-course/questions.jsonl',
  '09-course/practices.jsonl',
] as const satisfies readonly ShardMergeJsonlPath[];

export interface SplitAuthoringTaskOptions {
  agents: number;
  checkpoint?: ParallelCheckpointId;
  createdAt?: string;
}

export interface AuthoringShardPlan {
  shard_id: string;
  scope_kind: 'coverage_unit' | 'course_unit';
  scope_ids: string[];
  manifest_path: string;
  instruction_path: string;
  agent_root: string;
  output_root: string;
}

export interface SplitAuthoringTaskResult {
  workspace: string;
  workspace_id: string;
  checkpoint: ParallelCheckpointId;
  input_hash: string;
  source: { commit: string; tree: string };
  plan_path: string;
  shards: AuthoringShardPlan[];
}

export interface ActiveAuthoringShard {
  manifest: AgentShardManifest;
  shard_root: string;
  instruction_path: string;
  agent_root: string;
  output_root: string;
}

export interface ShardWorkspaceIdentity {
  workspace_id: string;
  commit: string;
  tree: string;
}

function assertInside(root: string, target: string, label: string): void {
  const relative = path.relative(root, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} 路径越界：${target}`);
  }
}

function normalizeInput(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('分片输入不接受 NaN 或 Infinity。');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeInput);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === 'content_hash' || key === 'created_at') continue;
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key] = normalizeInput(item);
    }
    return result;
  }
  throw new Error(`分片输入不支持 ${typeof value}。`);
}

async function readYamlObject(file: string): Promise<Record<string, unknown>> {
  const value: unknown = YAML.parse(await readFile(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file} 的 YAML 根节点必须是对象。`);
  }
  return value as Record<string, unknown>;
}

async function readJsonl(file: string): Promise<Record<string, unknown>[]> {
  const values: Record<string, unknown>[] = [];
  const text = await readFile(file, 'utf8');
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`${file}:${index + 1} JSON 解析失败：${(error as Error).message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${file}:${index + 1} 必须是 JSON 对象。`);
    }
    values.push(value as Record<string, unknown>);
  }
  return values;
}

function sortObjects(values: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...values].sort((left, right) => compareCanonicalString(String(left.id ?? ''), String(right.id ?? '')));
}

export async function loadShardWorkspaceIdentity(workspace: string): Promise<ShardWorkspaceIdentity> {
  const root = path.resolve(workspace);
  const input = YAML.parse(await readFile(path.join(root, 'project-input.yaml'), 'utf8')) as ProjectInput;
  if (!input || input.spec_version !== 'ptkg-project-input@1' || typeof input.workspace_id !== 'string') {
    throw new Error('project-input.yaml 不是有效的 ptkg-project-input@1。');
  }
  const commit = input.repository?.commit;
  const tree = input.repository?.tree;
  if (!SHA40.test(commit ?? '') || !SHA40.test(tree ?? '')) {
    throw new Error('task-split 要求 project-input.yaml 锁定 40 位 commit 和 tree。');
  }
  const source = await readYamlObject(path.join(root, '01-source', 'source-contract.yaml'));
  const sourceProject = source.project_ref as Record<string, unknown> | undefined;
  const checkout = source.checkout as Record<string, unknown> | undefined;
  if (sourceProject?.commit !== commit || checkout?.expected_tree !== tree) {
    throw new Error('project-input 与 source-contract 的 commit/tree 不一致。');
  }
  return { workspace_id: input.workspace_id, commit, tree };
}

/**
 * Hashes only the immutable/upstream inputs for a checkpoint. Output targets are
 * excluded so a successful merge remains idempotent.
 */
async function loadAuthoringShardInput(
  workspace: string,
  checkpoint: ParallelCheckpointId,
): Promise<Record<string, unknown>> {
  const root = path.resolve(workspace);
  const projectInput = await readYamlObject(path.join(root, 'project-input.yaml'));
  const sourceContract = await readYamlObject(path.join(root, '01-source', 'source-contract.yaml'));
  const codeFacts = sortObjects(await readJsonl(path.join(root, '02-facts', 'code-facts.jsonl')));
  const coverage = await readYamlObject(path.join(root, '03-coverage', 'project-coverage.yaml'));
  const nodes = sortObjects(await readJsonl(path.join(root, '07-projection', 'nodes.jsonl')));
  const edges = sortObjects(await readJsonl(path.join(root, '07-projection', 'edges.jsonl')));
  const sources = sortObjects(await readJsonl(path.join(root, '07-projection', 'sources.jsonl')));

  let checkpointInput: Record<string, unknown>;
  if (checkpoint === 'competency_evidence') {
    const globalNodeTypes = new Set(['project', 'outcome', 'work_package']);
    const globalNodes = nodes.filter((node) => globalNodeTypes.has(String(node.type ?? '')));
    const globalIds = new Set(globalNodes.map((node) => String(node.id ?? '')));
    const globalEdges = edges.filter((edge) => globalIds.has(String(edge.from ?? '')) && globalIds.has(String(edge.to ?? '')));
    checkpointInput = { nodes: globalNodes, edges: globalEdges, sources };
  } else {
    const blueprint = await readYamlObject(path.join(root, '09-course', 'blueprint.yaml'));
    checkpointInput = {
      nodes,
      edges,
      sources,
      behavior_chains: sortObjects(await readJsonl(path.join(root, '04-behaviors', 'behavior-chains.jsonl'))),
      learning_slices: sortObjects(await readJsonl(path.join(root, '05-slices', 'learning-slices.jsonl'))),
      blueprint,
    };
  }

  return normalizeInput({ projectInput, sourceContract, codeFacts, coverage, checkpointInput }) as Record<string, unknown>;
}

export async function computeAuthoringShardInputHash(
  workspace: string,
  checkpoint: ParallelCheckpointId,
): Promise<string> {
  return createHash('sha256')
    .update(canonicalJson(await loadAuthoringShardInput(workspace, checkpoint)))
    .digest('hex');
}

function instructionFor(manifest: AgentShardManifest): string {
  const paths = manifest.allowed_jsonl_paths.map((item) => `- \`output/${item}\``).join('\n');
  const cards = manifest.allowed_card_glob ? `\n- \`output/${manifest.allowed_card_glob}\`` : '';
  return `# PTKG Agent shard: ${manifest.shard_id}

你只负责本分片声明的作用域对象：

作用域类型：${manifest.scope_kind}

${manifest.scope_ids.map((id) => `- \`${id}\``).join('\n')}

## 固定输入

- checkpoint: ${manifest.checkpoint}
- commit: ${manifest.source.commit}
- tree: ${manifest.source.tree}
- input_hash: ${manifest.input_hash}
- 只读输入快照: \`input/context.json\`

## 唯一允许写入的位置

当前工作目录是隔离的 \`agent-workspace/\`。只能写其中的 \`output/\`；\`input/context.json\` 是本轮固定快照，不得修改。不得访问或修改 canonical workspace、其他 shard、源码 checkout 或全局 blueprint。

允许的输出：

${paths}${cards}

每个对象必须有稳定 ID，只能使用 \`candidate\` 或 \`unresolved\`。只生成与本分片作用域直接相关的候选；不得创建教师批准、可信签名、Project Readiness Gate、跨单元全局前置关系或真实项目分工。完成后不要自行合并，先运行 \`ptkg author-seal <workspace> --shard ${manifest.shard_id}\`，再交由 \`ptkg author-merge\` dry-run。
`;
}

async function directoryEmpty(directory: string): Promise<boolean> {
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return true;
  if (info.isSymbolicLink()) throw new Error(`shard 目录不允许符号链接：${directory}`);
  if (!info.isDirectory()) return false;
  return (await readdir(directory)).length === 0;
}

async function assertDirectoryOrMissing(directory: string, label: string): Promise<void> {
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return;
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} 必须是普通目录。`);
}

function requiredCoverageGroups(coverage: Record<string, unknown>): string[][] {
  const units = Array.isArray(coverage.units) ? coverage.units as Array<Record<string, unknown>> : [];
  const declared = Array.isArray(coverage.required_unit_ids)
    ? coverage.required_unit_ids.filter((item): item is string => typeof item === 'string')
    : [];
  const unitById = new Map(units.map((unit) => [String(unit.id ?? ''), unit]));
  const missing = declared.filter((id) => !unitById.has(id));
  if (missing.length > 0) throw new Error(`required coverage unit 缺少定义：${missing.join(', ')}`);
  const required = [...new Set(declared)]
    .filter((id) => unitById.get(id)?.required !== false)
    .sort(compareCanonicalString);
  if (required.length === 0) throw new Error('project-coverage 没有可分片的 required units。');

  const parent = new Map(required.map((id) => [id, id]));
  const find = (id: string): string => {
    const current = parent.get(id)!;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort(compareCanonicalString);
    parent.set(second!, first!);
  };
  const behaviorOwner = new Map<string, string>();
  for (const id of required) {
    const refs = unitById.get(id)?.behavior_refs;
    if (!Array.isArray(refs)) continue;
    for (const ref of refs.filter((value): value is string => typeof value === 'string')) {
      const owner = behaviorOwner.get(ref);
      if (owner) union(owner, id);
      else behaviorOwner.set(ref, id);
    }
  }
  const groups = new Map<string, string[]>();
  for (const id of required) {
    const root = find(id);
    const group = groups.get(root) ?? [];
    group.push(id);
    groups.set(root, group);
  }
  return [...groups.values()]
    .map((group) => group.sort(compareCanonicalString))
    .sort((left, right) => compareCanonicalString(left[0]!, right[0]!));
}

async function courseUnitGroups(root: string): Promise<string[][]> {
  const blueprint = await readYamlObject(path.join(root, '09-course', 'blueprint.yaml'));
  const stages = Array.isArray(blueprint.stages) ? blueprint.stages as Array<Record<string, unknown>> : [];
  const unitIds = stages
    .filter((stage) => stage.layer !== 'project_reference')
    .flatMap((stage) => Array.isArray(stage.unit_ids) ? stage.unit_ids : [])
    .filter((value): value is string => typeof value === 'string' && Boolean(value));
  const unique = [...new Set(unitIds)].sort(compareCanonicalString);
  if (unique.length === 0) throw new Error('course blueprint 没有可并行的非 project_reference unit。');
  return unique.map((id) => [id]);
}

export async function loadAuthoringScopeGroups(
  workspace: string,
  checkpoint: ParallelCheckpointId,
): Promise<{ kind: 'coverage_unit' | 'course_unit'; groups: string[][] }> {
  const root = path.resolve(workspace);
  if (checkpoint === 'competency_evidence') {
    return { kind: 'coverage_unit', groups: requiredCoverageGroups(await readYamlObject(path.join(root, '03-coverage', 'project-coverage.yaml'))) };
  }
  return { kind: 'course_unit', groups: await courseUnitGroups(root) };
}

export async function splitAuthoringTasks(
  workspace: string,
  options: SplitAuthoringTaskOptions,
): Promise<SplitAuthoringTaskResult> {
  const root = path.resolve(workspace);
  if (!Number.isInteger(options.agents) || options.agents < 2 || options.agents > 32) {
    throw new Error('--agents 必须是 2..32 的整数。');
  }
  const next = (await getProjectStatus(root)).next_checkpoint;
  let checkpoint = options.checkpoint;
  if (!checkpoint) {
    if (!next || !(PARALLEL_CHECKPOINTS as readonly string[]).includes(next)) {
      throw new Error(`当前 checkpoint ${next ?? '(none)'} 必须由单写者完成，不能自动分片。`);
    }
    checkpoint = next as ParallelCheckpointId;
  }
  if (!(PARALLEL_CHECKPOINTS as readonly string[]).includes(checkpoint)) {
    throw new Error(`checkpoint ${checkpoint} 不支持并行分片。`);
  }
  if (checkpoint !== next) {
    throw new Error(`checkpoint ${checkpoint} 不是当前可执行阶段 ${next ?? '(none)'}。`);
  }

  const identity = await loadShardWorkspaceIdentity(root);
  const coverage = await readYamlObject(path.join(root, '03-coverage', 'project-coverage.yaml'));
  const scopeKind = checkpoint === 'competency_evidence' ? 'coverage_unit' as const : 'course_unit' as const;
  const scopeGroups = checkpoint === 'competency_evidence'
    ? requiredCoverageGroups(coverage)
    : await courseUnitGroups(root);
  if (options.agents > scopeGroups.length) {
    throw new Error(`Agent 数 ${options.agents} 超过不可拆分作用域组数 ${scopeGroups.length}。`);
  }

  const shardInput = await loadAuthoringShardInput(root, checkpoint);
  const inputSnapshot = `${canonicalJson(shardInput)}\n`;
  const inputHash = createHash('sha256').update(canonicalJson(shardInput)).digest('hex');
  if (!SHA64.test(inputHash)) throw new Error('内部错误：分片 input hash 无效。');
  const createdAt = options.createdAt ?? new Date().toISOString();
  const allowed = checkpoint === 'competency_evidence' ? [...COMPETENCY_PATHS] : [...COURSE_PATHS];
  const assignments = Array.from({ length: options.agents }, () => [] as string[]);
  scopeGroups.forEach((group, index) => assignments[index % options.agents]?.push(...group));
  assignments.forEach((assignment) => assignment.sort(compareCanonicalString));

  const shardsRoot = path.join(root, '.ptkg', 'shards');
  assertInside(root, shardsRoot, 'shards root');
  await assertDirectoryOrMissing(path.join(root, '.ptkg'), '.ptkg');
  await assertDirectoryOrMissing(shardsRoot, 'shards root');
  await assertDirectoryOrMissing(path.join(root, '.ptkg', 'coordination'), 'coordination');
  await assertDirectoryOrMissing(path.join(root, '.ptkg', 'locks'), 'locks');
  const prefix = `${checkpoint}-${inputHash.slice(0, 8)}`;
  const plans: AuthoringShardPlan[] = assignments.map((unitIds, index) => {
    const shardId = `${prefix}-${String(index + 1).padStart(2, '0')}`;
    const shardRoot = path.join(shardsRoot, shardId);
    assertInside(shardsRoot, shardRoot, 'shard');
    return {
      shard_id: shardId,
      scope_kind: scopeKind,
      scope_ids: unitIds,
      manifest_path: path.join(shardRoot, 'manifest.json'),
      instruction_path: path.join(shardRoot, 'instruction.md'),
      agent_root: path.join(shardRoot, 'agent-workspace'),
      output_root: path.join(shardRoot, 'agent-workspace', 'output'),
    };
  });
  const manifests = plans.map((plan): AgentShardManifest => ({
    spec_version: 'ptkg-agent-shard@1',
    shard_id: plan.shard_id,
    workspace_id: identity.workspace_id,
    checkpoint,
    input_hash: inputHash,
    source: { commit: identity.commit, tree: identity.tree },
    scope_kind: plan.scope_kind,
    scope_ids: plan.scope_ids,
    output_root: 'agent-workspace/output',
    allowed_jsonl_paths: allowed,
    allowed_card_glob: checkpoint === 'course_assets' ? '09-course/cards/*.md' : null,
    status: 'candidate',
    created_at: createdAt,
  }));

  const created: string[] = [];
  const planPath = path.join(root, '.ptkg', 'coordination', 'task-plan.json');
  await withWorkspaceLease(
    path.join(root, '.ptkg', 'locks', 'authoring-coordinator.lock'),
    { owner: `task-split:${process.pid}`, ttlMs: 30 * 60_000 },
    async () => {
      const lockedInputHash = await computeAuthoringShardInputHash(root, checkpoint);
      if (lockedInputHash !== inputHash) throw new Error('分片期间只读上游输入发生变化，请重新运行 task-split。');
      for (const plan of plans) {
        if (!await directoryEmpty(path.dirname(plan.manifest_path))) {
          throw new Error(`拒绝覆盖非空 shard：${plan.shard_id}`);
        }
      }
      try {
        await mkdir(shardsRoot, { recursive: true });
        for (const [index, plan] of plans.entries()) {
          const shardRoot = path.dirname(plan.manifest_path);
          await mkdir(path.join(plan.agent_root, 'input'), { recursive: true });
          await mkdir(plan.output_root, { recursive: true });
          created.push(shardRoot);
          const manifest = manifests[index]!;
          await writeFile(plan.manifest_path, `${canonicalJson(manifest)}\n`, { encoding: 'utf8', flag: 'wx' });
          await writeFile(plan.instruction_path, instructionFor(manifest), { encoding: 'utf8', flag: 'wx' });
          await writeFile(path.join(plan.agent_root, 'input', 'context.json'), inputSnapshot, { encoding: 'utf8', flag: 'wx' });
        }
        const existingPlan = await lstat(planPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (existingPlan?.isSymbolicLink()) throw new Error('task-plan.json 不允许符号链接。');
        const taskPlan: AgentTaskPlan = {
          spec_version: 'ptkg-agent-task-plan@1',
          workspace_id: identity.workspace_id,
          checkpoint,
          input_hash: inputHash,
          source: { commit: identity.commit, tree: identity.tree },
          shards: manifests.map((manifest) => ({
            shard_id: manifest.shard_id,
            scope_kind: manifest.scope_kind,
            scope_ids: manifest.scope_ids,
            manifest_hash: sha256(canonicalJson(manifest)),
          })),
          state: 'active',
          created_at: createdAt,
        };
        await atomicWriteFile(planPath, `${canonicalJson(taskPlan)}\n`);
      } catch (error) {
        for (const directory of created.reverse()) {
          assertInside(shardsRoot, directory, 'cleanup shard');
          await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        }
        throw error;
      }
    },
  );

  return {
    workspace: root,
    workspace_id: identity.workspace_id,
    checkpoint,
    input_hash: inputHash,
    source: { commit: identity.commit, tree: identity.tree },
    plan_path: planPath,
    shards: plans,
  };
}

export const MERGEABLE_SHARD_PATHS = SHARD_MERGE_JSONL_PATHS;

/** Resolve one active shard for `ptkg author --shard`; merge re-validates every field. */
export async function loadActiveAuthoringShard(workspace: string, shardId: string): Promise<ActiveAuthoringShard> {
  if (!/^[a-z0-9._-]+$/i.test(shardId)) throw new Error(`非法 shard id：${shardId}`);
  const root = path.resolve(workspace);
  const planPath = path.join(root, '.ptkg', 'coordination', 'task-plan.json');
  const planInfo = await lstat(planPath);
  if (planInfo.isSymbolicLink() || !planInfo.isFile()) {
    throw new Error('活动 task plan 必须是普通文件。');
  }
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as AgentTaskPlan;
  const assignment = Array.isArray(plan.shards)
    ? plan.shards.find((entry) => entry.shard_id === shardId)
    : undefined;
  if (plan.spec_version !== 'ptkg-agent-task-plan@1' || plan.state !== 'active' || !assignment) {
    throw new Error(`shard 不在当前活动 task plan 中：${shardId}`);
  }
  const shardRoot = path.join(root, '.ptkg', 'shards', shardId);
  assertInside(path.join(root, '.ptkg', 'shards'), shardRoot, 'shard');
  const shardInfo = await lstat(shardRoot);
  if (shardInfo.isSymbolicLink() || !shardInfo.isDirectory()) throw new Error(`shard 不是普通目录：${shardId}`);
  const manifestPath = path.join(shardRoot, 'manifest.json');
  const manifestInfo = await lstat(manifestPath);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new Error(`shard manifest 不是普通文件：${shardId}`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AgentShardManifest;
  if (
    manifest.spec_version !== 'ptkg-agent-shard@1'
    || manifest.shard_id !== shardId
    || manifest.input_hash !== plan.input_hash
    || manifest.checkpoint !== plan.checkpoint
    || manifest.output_root !== 'agent-workspace/output'
    || manifest.scope_kind !== assignment.scope_kind
    || canonicalJson(manifest.scope_ids) !== canonicalJson(assignment.scope_ids)
    || sha256(canonicalJson(manifest)) !== assignment.manifest_hash
  ) {
    throw new Error(`shard manifest 与活动 task plan 不一致：${shardId}`);
  }
  const instructionPath = path.join(shardRoot, 'instruction.md');
  const agentRoot = path.join(shardRoot, 'agent-workspace');
  const outputRoot = path.join(shardRoot, ...manifest.output_root.split('/'));
  assertInside(shardRoot, outputRoot, 'shard output');
  const instructionInfo = await lstat(instructionPath);
  const agentInfo = await lstat(agentRoot);
  const inputInfo = await lstat(path.join(agentRoot, 'input', 'context.json'));
  const outputInfo = await lstat(outputRoot);
  if (instructionInfo.isSymbolicLink() || !instructionInfo.isFile()) throw new Error(`shard instruction 不是普通文件：${shardId}`);
  if (agentInfo.isSymbolicLink() || !agentInfo.isDirectory()) throw new Error(`shard agent workspace 不是普通目录：${shardId}`);
  if (inputInfo.isSymbolicLink() || !inputInfo.isFile()) throw new Error(`shard input snapshot 不是普通文件：${shardId}`);
  if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory()) throw new Error(`shard output 不是普通目录：${shardId}`);
  return { manifest, shard_root: shardRoot, instruction_path: instructionPath, agent_root: agentRoot, output_root: outputRoot };
}
