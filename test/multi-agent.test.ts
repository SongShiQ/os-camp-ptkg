import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import YAML from 'yaml';

import {
  atomicWriteFile,
  recoverWorkspaceLease,
  withWorkspaceLease,
  WorkspaceLeaseBusyError,
  WorkspaceLeaseStaleError,
} from '../src/io/atomic.ts';
import { mergeAuthoringShards } from '../src/project/author-merge.ts';
import { authorProject } from '../src/project/author.ts';
import { getProjectStatus } from '../src/project/status.ts';
import { sealAuthoringShard } from '../src/project/shard-seal.ts';
import { compareCanonicalString } from '../src/io/stable.ts';
import {
  computeAuthoringShardInputHash,
  splitAuthoringTasks,
  type AuthoringShardPlan,
} from '../src/project/task-split.ts';

const GOLDEN = path.resolve('fixtures/authoring/cgroup-golden');
const CREATED_AT = '2026-08-17T00:00:00.000Z';
const execFileAsync = promisify(execFile);

async function fixture(prefix: string, checkpoint: 'competency_evidence' | 'course_assets' = 'course_assets'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await cp(GOLDEN, root, { recursive: true });
  if (checkpoint === 'course_assets') {
    await rm(path.join(root, '09-course', 'cards'), { recursive: true, force: true });
  } else {
    const nodesFile = path.join(root, '07-projection', 'nodes.jsonl');
    const edgesFile = path.join(root, '07-projection', 'edges.jsonl');
    const nodes = (await readFile(nodesFile, 'utf8')).trim().split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type?: string })
      .filter((node) => node.type !== 'competency' && node.type !== 'evidence');
    const edges = (await readFile(edgesFile, 'utf8')).trim().split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type?: string })
      .filter((edge) => edge.type !== 'PROVEN_BY');
    await writeFile(nodesFile, `${nodes.map((node) => JSON.stringify(node)).join('\n')}\n`, 'utf8');
    await writeFile(edgesFile, `${edges.map((edge) => JSON.stringify(edge)).join('\n')}\n`, 'utf8');
  }
  return root;
}

async function writeShardJsonl(plan: AuthoringShardPlan, relative: string, values: unknown[]): Promise<void> {
  const file = path.join(plan.output_root, ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');
}

async function sealShards(root: string, shards: AuthoringShardPlan[]): Promise<void> {
  for (const shard of shards) await sealAuthoringShard(root, shard.shard_id);
}

function cardText(id: string, title: string, unitId: string): string {
  return `---
id: ${id}
title: ${title}
unit_ids:
  - ${unitId}
node_ids:
  - kc.parallel.card
source_refs:
  - src.parallel.card
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: parallel-test
content_hash: ""
---

${title} body.
`;
}

function courseObject(shard: AuthoringShardPlan, id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, unit_ids: [shard.scope_ids[0]], status: 'candidate', ...extra };
}

describe('M1 多 Agent task split', () => {
  it('稳定排序固定为 UTF-16 码元顺序且不受系统 locale 影响', () => {
    assert.deepEqual(
      ['中', 'z', 'A', '😀', 'é', 'a', 'Z'].sort(compareCanonicalString),
      ['A', 'Z', 'a', 'z', 'é', '中', '😀'],
    );
  });

  it('按稳定 coverage ID 轮转分片，并拒绝覆盖已有分片', async () => {
    const root = await fixture('ptkg-task-split-');
    try {
      const result = await splitAuthoringTasks(root, {
        agents: 3,
        checkpoint: 'course_assets',
        createdAt: CREATED_AT,
      });
      assert.equal(result.shards.length, 3);
      assert.match(result.input_hash, /^[0-9a-f]{64}$/);
      const assigned = result.shards.flatMap((shard) => shard.scope_ids);
      assert.equal(assigned.length, 15);
      assert.equal(new Set(assigned).size, 15);
      const sorted = [...assigned].sort(compareCanonicalString);
      assert.deepEqual(result.shards[0]?.scope_ids, sorted.filter((_, index) => index % 3 === 0));
      assert.deepEqual(result.shards[1]?.scope_ids, sorted.filter((_, index) => index % 3 === 1));
      assert.deepEqual(result.shards[2]?.scope_ids, sorted.filter((_, index) => index % 3 === 2));
      for (const shard of result.shards) {
        assert.equal((await stat(shard.output_root)).isDirectory(), true);
        const manifest = JSON.parse(await readFile(shard.manifest_path, 'utf8')) as Record<string, unknown>;
        assert.equal(manifest.spec_version, 'ptkg-agent-shard@1');
        assert.equal(manifest.input_hash, result.input_hash);
        assert.equal(manifest.output_root, 'agent-workspace/output');
        assert.equal(manifest.allowed_card_glob, '09-course/cards/*.md');
        assert.equal(manifest.scope_kind, 'course_unit');
        assert.match(await readFile(shard.instruction_path, 'utf8'), /只能写其中的 `output\/`/);
        assert.equal((await stat(path.join(shard.agent_root, 'input', 'context.json'))).isFile(), true);
      }
      await assert.rejects(
        splitAuthoringTasks(root, { agents: 3, checkpoint: 'course_assets', createdAt: CREATED_AT }),
        /拒绝覆盖非空 shard/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('course_assets 覆盖全部非 project_reference 单元，包括可选阶段', async () => {
    const root = await fixture('ptkg-task-optional-stage-');
    try {
      const blueprintFile = path.join(root, '09-course', 'blueprint.yaml');
      const blueprint = YAML.parse(await readFile(blueprintFile, 'utf8')) as {
        stages: Array<{ id: string; required?: boolean; unit_ids: string[] }>;
      };
      const optional = blueprint.stages[0]!;
      optional.required = false;
      await writeFile(blueprintFile, YAML.stringify(blueprint), 'utf8');
      const split = await splitAuthoringTasks(root, {
        agents: 2,
        checkpoint: 'course_assets',
        createdAt: CREATED_AT,
      });
      const assigned = new Set(split.shards.flatMap((shard) => shard.scope_ids));
      for (const unitId of optional.unit_ids) assert.equal(assigned.has(unitId), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('task-split 拒绝预先放置的 shard 目录符号链接', async (context) => {
    const root = await fixture('ptkg-task-root-symlink-');
    const outside = await mkdtemp(path.join(tmpdir(), 'ptkg-task-outside-'));
    try {
      const hash = await computeAuthoringShardInputHash(root, 'course_assets');
      const shardsRoot = path.join(root, '.ptkg', 'shards');
      await mkdir(shardsRoot, { recursive: true });
      const linked = path.join(shardsRoot, `course_assets-${hash.slice(0, 8)}-01`);
      try {
        await symlink(outside, linked, 'junction');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
          context.skip('当前 Windows 环境未授予创建目录链接权限。');
          return;
        }
        throw error;
      }
      await assert.rejects(
        splitAuthoringTasks(root, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT }),
        /shard 目录不允许符号链接/,
      );
      assert.equal((await readdir(outside)).length, 0);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it('相同只读输入产生同一 hash，真正上游变化会使 hash 改变', async () => {
    const left = await fixture('ptkg-task-hash-left-');
    const right = await fixture('ptkg-task-hash-right-');
    try {
      const first = await computeAuthoringShardInputHash(left, 'course_assets');
      const second = await computeAuthoringShardInputHash(right, 'course_assets');
      assert.equal(first, second);
      const blueprintFile = path.join(right, '09-course', 'blueprint.yaml');
      await writeFile(
        blueprintFile,
        (await readFile(blueprintFile, 'utf8')).replace('version: 0.3.0', 'version: 0.3.1'),
        'utf8',
      );
      assert.notEqual(await computeAuthoringShardInputHash(right, 'course_assets'), first);
    } finally {
      await Promise.all([rm(left, { recursive: true, force: true }), rm(right, { recursive: true, force: true })]);
    }
  });

  it('拒绝非法并行度、空分片和串行 checkpoint', async () => {
    const root = await fixture('ptkg-task-invalid-');
    try {
      await assert.rejects(splitAuthoringTasks(root, { agents: 1, checkpoint: 'course_assets' }), /2\.\.32/);
      await assert.rejects(splitAuthoringTasks(root, { agents: 16, checkpoint: 'course_assets' }), /超过不可拆分作用域组数/);
      await assert.rejects(
        splitAuthoringTasks(root, { agents: 2, checkpoint: 'project_contract' as never }),
        /不支持并行分片/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('拒绝跳过当前 checkpoint，即使目标本身支持并行', async () => {
    const root = await fixture('ptkg-task-stage-jump-', 'competency_evidence');
    try {
      await assert.rejects(
        splitAuthoringTasks(root, { agents: 2, checkpoint: 'course_assets' }),
        /不是当前可执行阶段 competency_evidence/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('共享 behavior_refs 的 coverage units 保持在同一不可拆分分片', async () => {
    const root = await fixture('ptkg-task-connected-', 'competency_evidence');
    try {
      const coverageFile = path.join(root, '03-coverage', 'project-coverage.yaml');
      const coverage = YAML.parse(await readFile(coverageFile, 'utf8')) as {
        units: Array<{ id: string; behavior_refs?: string[] }>;
      };
      const core = coverage.units.find((unit) => unit.id === 'coverage.cgroup.core')!;
      const cgroupfs = coverage.units.find((unit) => unit.id === 'coverage.cgroup.cgroupfs')!;
      core.behavior_refs = [...(core.behavior_refs ?? []), 'behavior.shared.connected'];
      cgroupfs.behavior_refs = [...(cgroupfs.behavior_refs ?? []), 'behavior.shared.connected'];
      await writeFile(coverageFile, YAML.stringify(coverage), 'utf8');
      const split = await splitAuthoringTasks(root, {
        agents: 2,
        checkpoint: 'competency_evidence',
        createdAt: CREATED_AT,
      });
      const owner = split.shards.find((shard) => shard.scope_ids.includes(core.id));
      assert.ok(owner);
      assert.equal(owner.scope_ids.includes(cgroupfs.id), true);
      assert.equal(split.shards.filter((shard) => shard.scope_ids.includes(cgroupfs.id)).length, 1);

      const planFile = path.join(root, '.ptkg', 'coordination', 'task-plan.json');
      const plan = JSON.parse(await readFile(planFile, 'utf8')) as {
        shards: Array<{ shard_id: string; scope_ids: string[] }>;
      };
      const ownerEntry = plan.shards.find((entry) => entry.shard_id === owner.shard_id)!;
      const otherEntry = plan.shards.find((entry) => entry.shard_id !== owner.shard_id)!;
      ownerEntry.scope_ids = ownerEntry.scope_ids.filter((id) => id !== cgroupfs.id);
      otherEntry.scope_ids.push(cgroupfs.id);
      await writeFile(planFile, `${JSON.stringify(plan)}\n`, 'utf8');
      await assert.rejects(mergeAuthoringShards(root), /拆散了不可分割的 scope group/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('author --shard 只返回活动分片指令，不改写全局 state', async () => {
    const root = await fixture('ptkg-task-author-shard-');
    try {
      const split = await splitAuthoringTasks(root, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT });
      const shard = split.shards[0]!;
      const initialStatus = await getProjectStatus(root);
      assert.equal(initialStatus.parallel_authoring?.shard_count, 2);
      assert.equal(initialStatus.parallel_authoring?.ready_shards, 0);
      assert.match(initialStatus.next_command ?? '', new RegExp(shard.shard_id));
      const result = await authorProject(root, 'manual', { shardId: shard.shard_id });
      assert.equal(result.checkpoint, 'course_assets');
      assert.equal(result.instruction_path, shard.instruction_path);
      assert.equal(result.log_path, null);
      assert.equal(await stat(path.join(root, '.ptkg', 'state.json')).catch(() => null), null);
      await assert.rejects(authorProject(root, 'manual', { shardId: '../outside' }), /非法 shard id/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('status 不为被篡改的 shard id 生成可复制命令', async () => {
    const root = await fixture('ptkg-task-status-tamper-');
    try {
      await splitAuthoringTasks(root, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT });
      const planFile = path.join(root, '.ptkg', 'coordination', 'task-plan.json');
      const plan = JSON.parse(await readFile(planFile, 'utf8')) as {
        shards: Array<{ shard_id: string }>;
      };
      plan.shards[0]!.shard_id = 'bad --help';
      await writeFile(planFile, `${JSON.stringify(plan)}\n`, 'utf8');
      const status = await getProjectStatus(root);
      assert.equal(status.parallel_authoring, null);
      assert.doesNotMatch(status.next_command ?? '', /bad --help/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('CLI 可完成 task-split、manual shard 和 status 闭环', async () => {
    const root = await fixture('ptkg-task-cli-');
    try {
      const splitRun = await execFileAsync(process.execPath, [
        'src/cli.ts',
        'task-split',
        root,
        '--agents',
        '2',
        '--checkpoint',
        'course_assets',
        '--json',
      ], { cwd: path.resolve('.') });
      const split = JSON.parse(splitRun.stdout) as { shards: Array<{ shard_id: string }> };
      assert.equal(split.shards.length, 2);
      const shardId = split.shards[0]!.shard_id;
      const authorRun = await execFileAsync(process.execPath, [
        'src/cli.ts',
        'author',
        root,
        '--agent',
        'manual',
        '--shard',
        shardId,
        '--json',
      ], { cwd: path.resolve('.') });
      const author = JSON.parse(authorRun.stdout) as { checkpoint: string; instruction_path: string };
      assert.equal(author.checkpoint, 'course_assets');
      assert.equal(await stat(author.instruction_path).then((info) => info.isFile()), true);
      const statusRun = await execFileAsync(process.execPath, ['src/cli.ts', 'status', root, '--json'], {
        cwd: path.resolve('.'),
      });
      const status = JSON.parse(statusRun.stdout) as { parallel_authoring: { shard_count: number } };
      assert.equal(status.parallel_authoring.shard_count, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('CLI 能读取 expected-token 并显式恢复过期协调器锁', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptkg-lease-cli-'));
    const locks = path.join(root, '.ptkg', 'locks');
    const lock = path.join(locks, 'authoring-coordinator.lock');
    try {
      await mkdir(locks, { recursive: true });
      await writeFile(lock, `${JSON.stringify({
        spec_version: 'ptkg-workspace-lease@1',
        token: 'expired-cli-token',
        owner: 'stopped-owner',
        pid: 1,
        acquired_at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-01T00:00:01.000Z',
      })}\n`, 'utf8');
      const run = await execFileAsync(process.execPath, [
        'src/cli.ts',
        'author-recover-lease',
        root,
        '--expected-token',
        'expired-cli-token',
        '--confirm-owner-stopped',
        '--json',
      ], { cwd: path.resolve('.') });
      const result = JSON.parse(run.stdout) as { recovered: boolean; lock: string };
      assert.equal(result.recovered, true);
      assert.equal(result.lock, lock);
      assert.equal(await stat(lock).catch(() => null), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('两个协调器并发 task-split 时只有一个能建立活动轮次', async () => {
    const root = await fixture('ptkg-task-concurrent-');
    try {
      const results = await Promise.allSettled([
        splitAuthoringTasks(root, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT }),
        splitAuthoringTasks(root, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT }),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      const plan = JSON.parse(
        await readFile(path.join(root, '.ptkg', 'coordination', 'task-plan.json'), 'utf8'),
      ) as { shards: Array<{ shard_id: string }> };
      const shardIds = plan.shards.map((entry) => entry.shard_id);
      assert.equal(shardIds.length, 2);
      assert.deepEqual((await readdir(path.join(root, '.ptkg', 'shards'))).sort(), [...shardIds].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('M1 确定性 author merge', () => {
  it('dry-run 不改 canonical，write 后按 ID 合并且重复执行逐字节一致', async () => {
    const root = await fixture('ptkg-author-merge-');
    try {
      const split = await splitAuthoringTasks(root, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT });
      const questionFile = path.join(root, '09-course', 'questions.jsonl');
      const before = await readFile(questionFile, 'utf8');
      await writeShardJsonl(split.shards[0]!, '09-course/questions.jsonl', [
        courseObject(split.shards[0]!, 'question.parallel.z', { title: 'Z' }),
      ]);
      await writeShardJsonl(split.shards[1]!, '09-course/questions.jsonl', [
        courseObject(split.shards[1]!, 'question.parallel.a', { title: 'A' }),
      ]);
      await sealShards(root, split.shards);

      const dry = await mergeAuthoringShards(root);
      assert.equal(dry.dry_run, true);
      assert.equal(dry.applied, false);
      assert.equal(dry.summary.accepted, 2);
      assert.equal(await readFile(questionFile, 'utf8'), before);

      const applied = await mergeAuthoringShards(root, { write: true });
      assert.equal(applied.applied, true);
      assert.equal(applied.summary.conflict + applied.summary.stale + applied.summary.rejected, 0);
      const after = await readFile(questionFile, 'utf8');
      assert.notEqual(after, before);
      const ids = after.trim().split(/\r?\n/).map((line) => (JSON.parse(line) as { id: string }).id);
      assert.deepEqual(ids, [...ids].sort(compareCanonicalString));

      const repeated = await mergeAuthoringShards(root, { write: true });
      assert.equal(repeated.applied, true);
      assert.equal(repeated.summary.duplicate, 2);
      assert.equal(await readFile(questionFile, 'utf8'), after);
      const report = JSON.parse(await readFile(path.join(root, '.ptkg', 'coordination', 'merge-report.json'), 'utf8')) as {
        applied: boolean;
      };
      assert.equal(report.applied, true);
      const plan = JSON.parse(await readFile(path.join(root, '.ptkg', 'coordination', 'task-plan.json'), 'utf8')) as {
        state: string;
      };
      assert.equal(plan.state, 'merged');
      assert.equal((await getProjectStatus(root)).parallel_authoring?.merged, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('未封存的分片既不 ready，也不能合并', async () => {
    const root = await fixture('ptkg-author-unsealed-');
    try {
      const split = await splitAuthoringTasks(root, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT });
      for (const [index, shard] of split.shards.entries()) {
        await writeShardJsonl(shard, '09-course/questions.jsonl', [
          courseObject(shard, `question.parallel.unsealed-${index}`),
        ]);
      }
      const status = await getProjectStatus(root);
      assert.equal(status.parallel_authoring?.ready_shards, 0);
      assert.deepEqual(status.parallel_authoring?.pending_shard_ids, split.shards.map((shard) => shard.shard_id));
      const report = await mergeAuthoringShards(root, { write: true });
      assert.equal(report.applied, false);
      assert.equal(report.summary.rejected, 2);
      assert.ok(report.items.every((entry) => entry.disposition === 'rejected' && entry.path === 'seal.json'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('封存后增、删、改任一输出都会使分片失效', async () => {
    for (const mutation of ['add', 'delete', 'modify'] as const) {
      const root = await fixture(`ptkg-author-seal-${mutation}-`);
      try {
        const split = await splitAuthoringTasks(root, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT });
        for (const [index, shard] of split.shards.entries()) {
          await writeShardJsonl(shard, '09-course/questions.jsonl', [
            courseObject(shard, `question.parallel.${mutation}-${index}`),
          ]);
        }
        await sealShards(root, split.shards);
        const target = path.join(split.shards[0]!.output_root, '09-course', 'questions.jsonl');
        if (mutation === 'add') {
          await writeFile(path.join(split.shards[0]!.output_root, 'extra.txt'), 'added\n', 'utf8');
        } else if (mutation === 'delete') {
          await rm(target);
        } else {
          await writeFile(target, `${await readFile(target, 'utf8')}changed\n`, 'utf8');
        }
        const status = await getProjectStatus(root);
        assert.ok(status.parallel_authoring?.invalid_shard_ids.includes(split.shards[0]!.shard_id));
        assert.match(status.next_command ?? '', /author-seal/);
        const report = await mergeAuthoringShards(root);
        assert.equal(report.applied, false);
        assert.ok(report.items.some((entry) => entry.shard_id === split.shards[0]!.shard_id
          && entry.path === 'seal.json'
          && /(seal 后 output 已发生变化|shard output 为空)/.test(entry.reason)));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('manifest scope 被篡改后即使保留旧 seal 也必须拒绝', async () => {
    const root = await fixture('ptkg-author-manifest-tamper-');
    try {
      const split = await splitAuthoringTasks(root, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT });
      for (const [index, shard] of split.shards.entries()) {
        await writeShardJsonl(shard, '09-course/questions.jsonl', [
          courseObject(shard, `question.parallel.manifest-${index}`),
        ]);
      }
      await sealShards(root, split.shards);
      const manifestFile = split.shards[0]!.manifest_path;
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as { scope_ids: string[] };
      manifest.scope_ids = [split.shards[1]!.scope_ids[0]!];
      await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`, 'utf8');
      const report = await mergeAuthoringShards(root, { write: true });
      assert.equal(report.applied, false);
      assert.ok(report.items.some((entry) => entry.shard_id === split.shards[0]!.shard_id
        && entry.path === 'manifest.json'
        && entry.disposition === 'stale'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('同 ID 不同内容产生冲突，write 保持全有或全无', async () => {
    const root = await fixture('ptkg-author-conflict-');
    try {
      const split = await splitAuthoringTasks(root, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT });
      const questionFile = path.join(root, '09-course', 'questions.jsonl');
      const before = await readFile(questionFile, 'utf8');
      await writeShardJsonl(split.shards[0]!, '09-course/questions.jsonl', [
        courseObject(split.shards[0]!, 'question.parallel.conflict', { title: 'left' }),
      ]);
      await writeShardJsonl(split.shards[1]!, '09-course/questions.jsonl', [
        courseObject(split.shards[1]!, 'question.parallel.conflict', { title: 'right' }),
      ]);
      await sealShards(root, split.shards);
      const report = await mergeAuthoringShards(root, { write: true });
      assert.equal(report.applied, false);
      assert.equal(report.summary.conflict, 1);
      assert.equal(await readFile(questionFile, 'utf8'), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('拒绝过期输入、未声明文件和提权状态', async () => {
    const staleRoot = await fixture('ptkg-author-stale-');
    const unsafeRoot = await fixture('ptkg-author-unsafe-');
    try {
      const stale = await splitAuthoringTasks(staleRoot, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT });
      for (const [index, shard] of stale.shards.entries()) {
        await writeShardJsonl(shard, '09-course/questions.jsonl', [
          courseObject(shard, `question.parallel.stale-${index}`),
        ]);
      }
      await sealShards(staleRoot, stale.shards);
      const blueprint = path.join(staleRoot, '09-course', 'blueprint.yaml');
      await writeFile(
        blueprint,
        (await readFile(blueprint, 'utf8')).replace('version: 0.3.0', 'version: 0.3.1'),
        'utf8',
      );
      const staleReport = await mergeAuthoringShards(staleRoot, { write: true });
      assert.equal(staleReport.applied, false);
      assert.equal(staleReport.summary.stale, 2);

      const unsafe = await splitAuthoringTasks(unsafeRoot, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT });
      await mkdir(unsafe.shards[0]!.output_root, { recursive: true });
      await writeFile(path.join(unsafe.shards[0]!.output_root, 'undeclared.txt'), 'no\n', 'utf8');
      await writeShardJsonl(unsafe.shards[1]!, '09-course/questions.jsonl', [
        courseObject(unsafe.shards[1]!, 'question.parallel.escalation', { status: 'approved' }),
      ]);
      await sealShards(unsafeRoot, unsafe.shards);
      const unsafeReport = await mergeAuthoringShards(unsafeRoot);
      assert.equal(unsafeReport.applied, false);
      assert.ok(unsafeReport.summary.rejected >= 2);
    } finally {
      await Promise.all([
        rm(staleRoot, { recursive: true, force: true }),
        rm(unsafeRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it('新的活动 task plan 会保留但忽略旧轮次分片', async () => {
    const root = await fixture('ptkg-author-active-plan-');
    try {
      const old = await splitAuthoringTasks(root, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT });
      for (const [index, shard] of old.shards.entries()) {
        await writeShardJsonl(shard, '09-course/questions.jsonl', [
          courseObject(shard, `question.parallel.old-${index}`),
        ]);
      }
      const blueprint = path.join(root, '09-course', 'blueprint.yaml');
      await writeFile(
        blueprint,
        (await readFile(blueprint, 'utf8')).replace('version: 0.3.0', 'version: 0.3.1'),
        'utf8',
      );
      const current = await splitAuthoringTasks(root, {
        agents: 2,
        checkpoint: 'course_assets',
        createdAt: '2026-08-17T00:01:00.000Z',
      });
      for (const [index, shard] of current.shards.entries()) {
        await writeShardJsonl(shard, '09-course/questions.jsonl', [
          courseObject(shard, `question.parallel.current-${index}`),
        ]);
      }
      await sealShards(root, current.shards);
      const report = await mergeAuthoringShards(root);
      assert.deepEqual(report.shard_ids, current.shards.map((shard) => shard.shard_id));
      assert.equal(report.summary.stale, 0);
      assert.equal(report.summary.accepted, 2);
      assert.equal((await readdir(path.join(root, '.ptkg', 'shards'))).length, 4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('知识卡按稳定 ID 合并并规范化 LF', async () => {
    const root = await fixture('ptkg-author-card-');
    try {
      const split = await splitAuthoringTasks(root, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT });
      for (const [index, shard] of split.shards.entries()) {
        const relative = `09-course/cards/card.parallel.${index}.md`;
        const file = path.join(shard.output_root, ...relative.split('/'));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, cardText(`card.parallel.${index}`, `Card ${index}`, shard.scope_ids[0]!).replaceAll('\n', '\r\n'), 'utf8');
      }
      await sealShards(root, split.shards);
      const report = await mergeAuthoringShards(root, { write: true });
      assert.equal(report.applied, true);
      assert.equal(report.summary.accepted, 2);
      for (let index = 0; index < 2; index++) {
        const text = await readFile(path.join(root, '09-course', 'cards', `card.parallel.${index}.md`), 'utf8');
        assert.equal(text.includes('\r'), false);
        assert.match(text, new RegExp(`id: card\\.parallel\\.${index}`));
      }
      const repeated = await mergeAuthoringShards(root);
      assert.equal(repeated.summary.duplicate, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('shard output 符号链接不能逃逸', async (context) => {
    const root = await fixture('ptkg-author-symlink-');
    try {
      const split = await splitAuthoringTasks(root, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT });
      const linked = path.join(split.shards[0]!.output_root, '09-course', 'questions.jsonl');
      await mkdir(path.dirname(linked), { recursive: true });
      try {
        await symlink(path.join(root, '09-course', 'questions.jsonl'), linked, 'file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
          context.skip('当前 Windows 环境未授予创建符号链接权限。');
          return;
        }
        throw error;
      }
      await assert.rejects(sealAuthoringShard(root, split.shards[0]!.shard_id), /符号链接/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('behavior/slice 不能越过自己的 coverage claim', async () => {
    const root = await fixture('ptkg-author-claim-', 'competency_evidence');
    try {
      const split = await splitAuthoringTasks(root, {
        agents: 2,
        checkpoint: 'competency_evidence',
        createdAt: CREATED_AT,
      });
      const left = split.shards[0]!;
      const right = split.shards[1]!;
      await writeShardJsonl(left, '04-behaviors/behavior-chains.jsonl', [
        {
          id: 'behavior.parallel.outside-claim',
          status: 'candidate',
          coverage_refs: [right.scope_ids[0]],
        },
      ]);
      await writeShardJsonl(right, '04-behaviors/behavior-chains.jsonl', [
        {
          id: 'behavior.parallel.owned',
          status: 'candidate',
          coverage_refs: [right.scope_ids[0]],
        },
      ]);
      await sealShards(root, split.shards);
      const report = await mergeAuthoringShards(root);
      assert.equal(report.applied, false);
      assert.ok(report.items.some((entry) => entry.object_id === 'behavior.parallel.outside-claim'
        && entry.disposition === 'rejected'
        && /越过 shard scope claim/.test(entry.reason)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('course asset 必须且只能绑定一个获授权 unit', async () => {
    const root = await fixture('ptkg-author-course-unit-');
    try {
      const split = await splitAuthoringTasks(root, { agents: 2, checkpoint: 'course_assets', createdAt: CREATED_AT });
      const shard = split.shards.find((entry) => entry.scope_ids.length >= 2)!;
      await writeShardJsonl(shard, '09-course/questions.jsonl', [{
        id: 'question.parallel.multi-unit',
        unit_ids: shard.scope_ids.slice(0, 2),
        status: 'candidate',
      }]);
      const cardRelative = '09-course/cards/card.parallel.multi-unit.md';
      const cardFile = path.join(shard.output_root, ...cardRelative.split('/'));
      await mkdir(path.dirname(cardFile), { recursive: true });
      await writeFile(
        cardFile,
        cardText('card.parallel.multi-unit', 'Multi unit', shard.scope_ids[0]!).replace(
          'node_ids:',
          `  - ${shard.scope_ids[1]}\nnode_ids:`,
        ),
        'utf8',
      );
      for (const other of split.shards.filter((entry) => entry !== shard)) {
        await writeShardJsonl(other, '09-course/questions.jsonl', [courseObject(other, `question.parallel.${other.shard_id}`)]);
      }
      await sealShards(root, split.shards);
      const report = await mergeAuthoringShards(root);
      assert.equal(report.applied, false);
      assert.ok(report.items.some((entry) => entry.object_id === 'question.parallel.multi-unit'
        && entry.disposition === 'rejected'
        && /只能绑定一个 course unit/.test(entry.reason)));
      assert.ok(report.items.some((entry) => entry.object_id === 'card.parallel.multi-unit'
        && entry.disposition === 'rejected'
        && /只能绑定一个 course unit/.test(entry.reason)), JSON.stringify(report.items));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('M1 原子写与 workspace lease', () => {
  it('原子替换目标并在失败时清理 sibling temp', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptkg-atomic-'));
    try {
      const file = path.join(root, 'value.txt');
      await writeFile(file, 'old\n', 'utf8');
      await atomicWriteFile(file, 'new\n');
      assert.equal(await readFile(file, 'utf8'), 'new\n');

      const directoryTarget = path.join(root, 'directory-target');
      await mkdir(directoryTarget);
      await assert.rejects(atomicWriteFile(directoryTarget, 'cannot replace a directory\n'));
      assert.equal((await readdir(root)).some((name) => name.startsWith('.directory-target.tmp-')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('同一时间只有一个 owner，异常后释放，过期 lease 必须显式恢复', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptkg-lease-'));
    const lock = path.join(root, 'author-merge.lock');
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = withWorkspaceLease(lock, { owner: 'first', ttlMs: 60_000 }, async () => gate);
      while (!await stat(lock).catch(() => null)) await new Promise((resolve) => setTimeout(resolve, 5));
      await assert.rejects(
        withWorkspaceLease(lock, { owner: 'second', ttlMs: 60_000 }, async () => undefined),
        WorkspaceLeaseBusyError,
      );
      release();
      await first;
      assert.equal(await stat(lock).catch(() => null), null);

      await assert.rejects(
        withWorkspaceLease(lock, { owner: 'throws', ttlMs: 60_000 }, async () => { throw new Error('boom'); }),
        /boom/,
      );
      assert.equal(await stat(lock).catch(() => null), null);

      await writeFile(lock, `${JSON.stringify({
        spec_version: 'ptkg-workspace-lease@1',
        token: 'expired-token',
        owner: 'expired',
        pid: 1,
        acquired_at: '2026-08-16T00:00:00.000Z',
        expires_at: '2026-08-16T00:00:01.000Z',
      })}\n`, 'utf8');
      await assert.rejects(
        withWorkspaceLease(
          lock,
          { owner: 'replacement', ttlMs: 1_000, now: () => Date.parse(CREATED_AT) },
          async () => 'unsafe-auto-recovery',
        ),
        WorkspaceLeaseStaleError,
      );
      await assert.rejects(
        recoverWorkspaceLease(lock, {
          expectedToken: 'wrong-token',
          confirmOwnerStopped: true,
          now: () => Date.parse(CREATED_AT),
        }),
        /token 已变化/,
      );
      await assert.rejects(
        recoverWorkspaceLease(lock, {
          expectedToken: 'expired-token',
          confirmOwnerStopped: false,
          now: () => Date.parse(CREATED_AT),
        }),
        /确认旧 owner 进程已经停止/,
      );
      await recoverWorkspaceLease(lock, {
        expectedToken: 'expired-token',
        confirmOwnerStopped: true,
        now: () => Date.parse(CREATED_AT),
      });
      const value = await withWorkspaceLease(
        lock,
        { owner: 'replacement', ttlMs: 1_000, now: () => Date.parse(CREATED_AT) },
        async () => 'recovered',
      );
      assert.equal(value, 'recovered');
      assert.equal(await stat(lock).catch(() => null), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('旧 owner 不删除已经换 token 的新 lease', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptkg-lease-token-'));
    const lock = path.join(root, 'lease.lock');
    try {
      await withWorkspaceLease(lock, { owner: 'old', ttlMs: 60_000 }, async () => {
        await writeFile(lock, `${JSON.stringify({
          spec_version: 'ptkg-workspace-lease@1',
          token: 'new-token',
          owner: 'new',
          pid: 2,
          acquired_at: CREATED_AT,
          expires_at: '2026-08-17T01:00:00.000Z',
        })}\n`, 'utf8');
      });
      const persisted = JSON.parse(await readFile(lock, 'utf8')) as { token: string };
      assert.equal(persisted.token, 'new-token');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
