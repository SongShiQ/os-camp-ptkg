/** PTKG 作者链 P0 回归测试。 */

import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { validateAuthoringRun } from '../src/authoring/validate.ts';
import { analyzeAuthoringImpact } from '../src/authoring/impact.ts';
import { executeAuthoringSlice } from '../src/authoring/execute.ts';
import { AUTHORING_RULE_CODES } from '../src/authoring/types.ts';
import type { AuthoringRuleCode } from '../src/authoring/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, '..', 'fixtures', 'authoring', 'cgroup-golden');
const BROKEN = path.join(HERE, '..', 'fixtures', 'authoring', 'broken');

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
  it('Docker 不可用时仍写入 failed/unresolved execution-result', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptkg-execution-failure-'));
    try {
      await cp(GOLDEN, root, { recursive: true });
      const result = await executeAuthoringSlice(root, {
        sliceId: 'slice.starryos.cgroup.mount-s0',
        image: 'example.invalid/ptkg@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        command: 'true',
        timeoutSeconds: 1,
        memoryMb: 128,
        processes: 8,
      });
      assert.equal(result.result.result_status, 'failed');
      assert.equal(result.result.status, 'unresolved');
      assert.match(String(result.result.environment_hash), /^[0-9a-f]{64}$/);
      assert.deepEqual(result.result.sandbox, {
        network: 'disabled',
        filesystem: 'read_only',
        secrets: 'none',
        resettable: true,
        push_allowed: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
