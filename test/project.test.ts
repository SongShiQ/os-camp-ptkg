import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { authorProject } from '../src/project/author.ts';
import { getProjectStatus } from '../src/project/status.ts';
import { initializeProjectWorkspace } from '../src/project/workspace.ts';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const fixture = path.join(root, 'fixtures', 'projects', 'rust-generic');

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function createRepository(parent: string): Promise<string> {
  const repository = path.join(parent, 'job-queue-kernel');
  await cp(fixture, repository, { recursive: true });
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'PTKG Test']);
  await git(repository, ['config', 'user.email', 'ptkg@example.invalid']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-m', 'fixture']);
  return repository;
}

describe('G1 通用项目工作区', () => {
  it('锁定本地 Rust 仓库、抽取事实并生成 manual checkpoint', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ptkg-project-'));
    const repository = await createRepository(temp);
    const document = path.join(temp, 'teacher-brief.md');
    await writeFile(document, '# Goal\nPrepare students to reason about a complete job queue subsystem.\n', 'utf8');
    const workspace = path.join(temp, 'workspace');
    const result = await initializeProjectWorkspace(workspace, {
      repository,
      goal: 'Prepare students for the complete job queue subsystem',
      documents: [document],
      cacheDir: path.join(temp, 'cache'),
    });

    assert.match(result.snapshot.projectRef.commit, /^[0-9a-f]{40}$/);
    assert.match(result.snapshot.tree, /^[0-9a-f]{40}$/);
    assert.equal(result.input.documents[0]?.privacy, 'private_local');
    assert.match(result.input.documents[0]?.locator ?? '', /^private:\/\//);
    assert.ok(result.analyzerResults.some((item) => item.analyzer === 'rust-declaration-v1'));
    assert.ok(result.analyzerResults.flatMap((item) => item.facts).some((item) => item.fact_kind === 'symbol'));
    assert.ok(result.analyzerResults.flatMap((item) => item.facts).some((item) => item.status === 'unresolved'));
    assert.equal(result.status.next_checkpoint, 'project_graph');
    assert.equal(result.status.checkpoints.find((item) => item.id === 'code_facts')?.status, 'complete');

    const manual = await authorProject(workspace, 'manual');
    assert.equal(manual.checkpoint, 'project_graph');
    assert.ok(manual.instruction_path);
    const instruction = await readFile(manual.instruction_path as string, 'utf8');
    assert.match(instruction, /完整项目为 L0/);
    assert.doesNotMatch(instruction, /真实贡献任务。.*真实贡献任务。/);

    const status = await getProjectStatus(workspace);
    assert.equal(status.source_locked, true);
    assert.equal(status.next_checkpoint, 'project_graph');
    const publicProjection = await Promise.all([
      'manifest.yaml', 'nodes.jsonl', 'edges.jsonl', 'sources.jsonl',
    ].map((file) => readFile(path.join(workspace, '07-projection', file), 'utf8')));
    assert.doesNotMatch(publicProjection.join('\n'), /Prepare students to reason/);
    assert.equal((await readFile(path.join(workspace, '.gitignore'), 'utf8')).trim(), '.ptkg/');
  });

  it('相同固定源码的 fact id 和 content hash 完全一致', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ptkg-determinism-'));
    const repository = await createRepository(temp);
    const cacheDir = path.join(temp, 'cache');
    const first = path.join(temp, 'first');
    const second = path.join(temp, 'second');
    await initializeProjectWorkspace(first, { repository, goal: 'Complete job queue subsystem', cacheDir });
    await initializeProjectWorkspace(second, { repository, goal: 'Complete job queue subsystem', cacheDir });
    const normalize = async (workspace: string) => (await readFile(path.join(workspace, '02-facts', 'code-facts.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string; content_hash: string })
      .map(({ id, content_hash }) => ({ id, content_hash }));
    assert.deepEqual(await normalize(first), await normalize(second));
  });

  it('仓库目标不明确时停在项目合同 checkpoint，不擅自选择', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ptkg-ambiguous-'));
    const repository = await createRepository(temp);
    const workspace = path.join(temp, 'workspace');
    await execFileAsync(process.execPath, [
      path.join(root, 'src', 'cli.ts'),
      'project-init',
      workspace,
      '--repo',
      repository,
      '--cache-dir',
      path.join(temp, 'cache'),
    ], { cwd: root, encoding: 'utf8' });
    const status = await getProjectStatus(workspace);
    assert.equal(status.next_checkpoint, 'project_contract');
    assert.equal(status.checkpoints[0]?.status, 'blocked');
    const manual = await authorProject(workspace, 'manual');
    const instruction = await readFile(manual.instruction_path as string, 'utf8');
    assert.match(instruction, /不得擅自选择/);
  });
});
