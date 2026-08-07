/** PTKG 作者链 P0 回归测试。 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import YAML from 'yaml';

import { validateAuthoringRun } from '../src/authoring/validate.ts';
import { analyzeAuthoringImpact } from '../src/authoring/impact.ts';
import { executeAuthoringSlice } from '../src/authoring/execute.ts';
import { computeContentHash } from '../src/authoring/hash.ts';
import { AUTHORING_RULE_CODES } from '../src/authoring/types.ts';
import type { AuthoringRuleCode } from '../src/authoring/types.ts';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, '..', 'fixtures', 'authoring', 'cgroup-golden');
const BROKEN = path.join(HERE, '..', 'fixtures', 'authoring', 'broken');

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function createWorkerRepository(parent: string): Promise<{ repository: string; commit: string; tree: string }> {
  const repository = path.join(parent, 'worker-source');
  await mkdir(repository, { recursive: true });
  await writeFile(path.join(repository, 'README.md'), '# Disposable worker fixture\n', 'utf8');
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'PTKG Test']);
  await git(repository, ['config', 'user.email', 'ptkg@example.invalid']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-m', 'fixture']);
  return {
    repository,
    commit: await git(repository, ['rev-parse', 'HEAD']),
    tree: await git(repository, ['show', '-s', '--format=%T', 'HEAD']),
  };
}

async function bindRunToWorkerRepository(runRoot: string, source: { repository: string; commit: string; tree: string }): Promise<void> {
  const contractPath = path.join(runRoot, '01-source', 'source-contract.yaml');
  const contract = YAML.parse(await readFile(contractPath, 'utf8')) as Record<string, unknown>;
  contract.project_ref = { repo: 'https://example.invalid/worker-fixture', commit: source.commit };
  contract.repository = 'https://example.invalid/worker-fixture';
  contract.checkout = {
    expected_tree: source.tree,
    candidates: [{ repository: source.repository, ref: 'refs/heads/main' }],
  };
  contract.content_hash = computeContentHash(contract);
  await writeFile(contractPath, YAML.stringify(contract), 'utf8');
  await rm(path.join(runRoot, '02-facts', 'workspace-verification.json'), { force: true });
}

describe('作者链 golden：cgroup 双链', () => {
  it('authoring profile 零 blocker', async () => {
    const result = await validateAuthoringRun(GOLDEN, 'authoring');

    assert.equal(result.passed, true);
    assert.equal(result.summary.blocker, 0);
    assert.deepEqual(result.findings, []);
    // code_facts 覆盖固定 commit 的全项目锚点索引（含未做深分支的来源事实），
    // 21 个锚点全部经 authoring-verify-workspace 对固定 commit 核验；
    // behavior/slice/execution 仍只有 mount 与 pids 两条做深的链。
    assert.deepEqual(result.summary.counts, {
      code_facts: 15,
      behavior_chains: 2,
      learning_slices: 2,
      execution_results: 2,
      review_events: 0,
      exception_events: 0,
      anchor_verifications: 21,
    });
  });

  it('完整项目覆盖骨架存在，但双链不冒充 complete course', async () => {
    const result = await validateAuthoringRun(GOLDEN, 'authoring');
    assert.ok(result.run);

    const coverage = result.run.projectCoverage;
    assert.equal(coverage.release_level, 'author_preview');
    assert.ok(Array.isArray(coverage.required_unit_ids));
    assert.ok(coverage.required_unit_ids.length >= 12);
    assert.ok(
      (coverage.units as Array<{ status: string }>).some((unit) => unit.status === 'skeleton'),
      '未做深的完整项目分支必须诚实保留为 skeleton',
    );
  });

  it('review profile 接受候选产物，publishing profile 要求可信发布事件', async () => {
    const review = await validateAuthoringRun(GOLDEN, 'review');
    const publishing = await validateAuthoringRun(GOLDEN, 'publishing');

    assert.equal(review.passed, true);
    assert.equal(publishing.passed, false);
    assert.ok(
      publishing.findings.some(
        (finding) =>
          finding.code === 'CANDIDATE-REVIEW-001' && finding.message.includes('release_owner'),
      ),
    );
  });
});

describe('作者链 broken：候选规则触发', () => {
  it('全部 16 条候选规则都至少触发一次', async () => {
    const result = await validateAuthoringRun(BROKEN, 'publishing');
    const fired = new Set<AuthoringRuleCode>(result.findings.map((finding) => finding.code));
    const missing = AUTHORING_RULE_CODES.filter((code) => !fired.has(code));

    assert.deepEqual(
      missing,
      [],
      `以下候选规则未被 broken fixture 触发：${missing.join(', ')}`,
    );
    assert.equal(result.passed, false);
    assert.ok(result.summary.blocker > 0);
  });

  it('同一输入连续校验产生完全一致的 findings', async () => {
    const first = await validateAuthoringRun(BROKEN, 'publishing');
    const second = await validateAuthoringRun(BROKEN, 'publishing');

    assert.deepEqual(first.findings, second.findings);
  });
});

describe('作者链 loader', () => {
  it('缺少运行目录时返回契约 finding，而不是抛异常', async () => {
    const result = await validateAuthoringRun(path.join(HERE, 'no-such-authoring-run'));

    assert.equal(result.run, null);
    assert.equal(result.passed, false);
    assert.ok(result.findings.length >= 8);
    assert.ok(result.findings.every((finding) => finding.code === 'CANDIDATE-CONTRACT-001'));
  });

  it('字段缺失的可解析契约产生 finding，不让语义校验器崩溃', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptkg-authoring-malformed-'));
    const files: Array<[string, string]> = [
      ['01-source/source-contract.yaml', '{}\n'],
      ['02-facts/code-facts.jsonl', ''],
      ['03-coverage/project-coverage.yaml', '{}\n'],
      ['04-behaviors/behavior-chains.jsonl', ''],
      ['05-slices/learning-slices.jsonl', ''],
      ['06-execution/execution-results.jsonl', ''],
      ['07-projection/manifest.yaml', '{}\n'],
      ['07-projection/nodes.jsonl', ''],
      ['07-projection/edges.jsonl', ''],
      ['07-projection/sources.jsonl', ''],
      ['08-governance/review-events.jsonl', ''],
    ];

    try {
      for (const [relative, content] of files) {
        const full = path.join(root, relative);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, content);
      }

      const result = await validateAuthoringRun(root);
      assert.equal(result.passed, false);
      assert.ok(result.findings.some((finding) => finding.code === 'CANDIDATE-CONTRACT-001'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('P1 增量影响分析', () => {
  it('同一运行继承对象并生成完整反向依赖', async () => {
    const result = await analyzeAuthoringImpact(GOLDEN, GOLDEN);
    assert.equal(result.report.added.length, 0);
    assert.equal(result.report.changed.length, 0);
    assert.ok(result.report.inherited.some((item) => item.id === 'fact.starryos.cgroup.mount-entry'));
    assert.ok(result.index.reverse_dependencies['anchor.starryos.sys-mount']?.includes('fact.starryos.cgroup.mount-entry'));
  });

  it('源码 blob 变化会使锚点及下游执行证据进入 stale', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptkg-impact-change-'));
    const oldDir = path.join(root, 'old');
    const newDir = path.join(root, 'new');
    try {
      await cp(GOLDEN, oldDir, { recursive: true });
      await cp(GOLDEN, newDir, { recursive: true });
      const verificationPath = path.join(newDir, '02-facts', 'anchor-verification.jsonl');
      const lines = (await readFile(verificationPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
      const target = lines.find((line) => line.anchor_id === 'anchor.starryos.sys-mount');
      assert.ok(target);
      target.blob_oid = '0000000000000000000000000000000000000000';
      await writeFile(verificationPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);

      const result = await analyzeAuthoringImpact(oldDir, newDir);
      const anchorChange = [...result.report.changed, ...result.report.stale].find((item) => item.id === 'anchor.starryos.sys-mount');
      assert.equal(anchorChange?.classification, 'behavioral');
      assert.ok(anchorChange?.invalidates.includes('exec.starryos.cgroup.mount-s0'));
      assert.ok(result.report.stale.some((item) => item.id === 'anchor.starryos.sys-mount'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('P2 Worker 安全合同', () => {
  it('固定镜像不可用时仍落盘可审计结果，并清理 disposable worktree', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ptkg-execution-failure-'));
    const root = path.join(temp, 'run');
    try {
      await cp(GOLDEN, root, { recursive: true });
      const source = await createWorkerRepository(temp);
      const cacheDir = path.join(temp, 'cache');
      await bindRunToWorkerRepository(root, source);
      const options = {
        sliceId: 'slice.starryos.cgroup.mount-s0',
        image: 'example.invalid/ptkg@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        command: 'true',
        testClasses: { positive: true, negative: true, concurrency: true as const, regression: true },
        timeoutSeconds: 1,
        memoryMb: 128,
        processes: 8,
        cacheDir,
      };
      const result = await executeAuthoringSlice(root, options);
      assert.equal(result.result.result_status, 'failed');
      assert.equal(result.result.status, 'unresolved');
      assert.match(String(result.result.environment_hash), /^[0-9a-f]{64}$/);
      assert.deepEqual(result.result.sandbox, {
        network: 'disabled',
        filesystem: 'disposable_worktree',
        secrets: 'none',
        resettable: true,
        push_allowed: false,
      });
      assert.deepEqual(result.result.test_classes, {
        positive: false,
        negative: false,
        concurrency: 'not_applicable',
        regression: false,
      });
      assert.equal((result.result.reset as { succeeded: boolean }).succeeded, true);
      assert.equal((result.result.source_snapshot as { tree: string }).tree, source.tree);
      assert.equal(result.result.image, undefined);
      const validation = await validateAuthoringRun(root, 'authoring');
      assert.equal(
        validation.findings.some(
          (finding) => finding.code === 'CANDIDATE-CONTRACT-001' && finding.subject === result.result.id,
        ),
        false,
        'Worker 生成的 failed/unresolved result 必须仍满足 execution-result Schema 与 content hash',
      );

      const artifactFiles = result.result.artifact_files as {
        stdout: string;
        stderr: string;
        environment: string;
        phases: string;
        reset: string;
      };
      for (const relative of Object.values(artifactFiles)) {
        await readFile(path.join(root, ...relative.split('/')));
      }
      const resetEvidence = JSON.parse(await readFile(path.join(root, ...artifactFiles.reset.split('/')), 'utf8')) as {
        cleanup: { succeeded: boolean };
      };
      assert.equal(resetEvidence.cleanup.succeeded, true);

      const verification = JSON.parse(await readFile(path.join(root, '02-facts', 'workspace-verification.json'), 'utf8')) as {
        cache_repo: string;
      };
      const registry = await git(verification.cache_repo, ['worktree', 'list', '--porcelain']);
      assert.doesNotMatch(registry, /ptkg-worker-/);

      const serialized = JSON.stringify(result.result);
      assert.doesNotMatch(serialized, /ptkg-worker-/);
      assert.equal(serialized.includes(source.repository), false);
      assert.equal(serialized.includes(cacheDir), false);

      await executeAuthoringSlice(root, options);
      const stored = (await readFile(path.join(root, '06-execution', 'execution-results.jsonl'), 'utf8'))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { id: string });
      assert.equal(stored.filter((item) => item.id === result.result.id).length, 1);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
