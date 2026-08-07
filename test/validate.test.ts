/**
 * PTKG 校验器回归测试。
 *
 * 核心断言不是「代码不崩」，而是两条纪律性保证：
 *   1. golden fixture（源自真实 commit 的 cgroup 切片）必须零 blocker——
 *      否则规范本身自相矛盾，教师照着写也过不了；
 *   2. broken fixture 必须让全部稳定规则每一条都至少触发一次——
 *      否则某条规则形同虚设，AI 可以绕过它而无人发现。
 *
 * 第 2 条是这套工具能不能约束 AI 的关键。规则不被测到，就等于不存在。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { validateBundle } from '../src/validate.ts';
import { diffBundles } from '../src/diff.ts';
import { loadBundle } from '../src/loader.ts';
import { formatGenerationReport } from '../src/reporter.ts';
import { isFixedCommitRef, RULE_CODES } from '../src/types.ts';
import type { RuleCode } from '../src/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, '..', 'fixtures', 'cgroup-golden');
const BROKEN = path.join(HERE, '..', 'fixtures', 'broken');

describe('golden fixture：真实 cgroup 切片', () => {
  it('零 blocker，可进入教师审核', async () => {
    const result = await validateBundle(GOLDEN);
    const blockers = result.findings.filter((f) => f.severity === 'blocker');

    assert.deepEqual(
      blockers.map((f) => `${f.code} ${f.subject}: ${f.message}`),
      [],
      'golden fixture 不应有 blocker',
    );
    assert.equal(result.passed, true);
  });

  it('覆盖 L0–L5 六层，不是只有知识点', async () => {
    const result = await validateBundle(GOLDEN);
    const byType = result.summary.counts.byType;

    for (const type of [
      'project',
      'outcome',
      'work_package',
      'competency',
      'practice',
      'knowledge',
    ]) {
      assert.ok((byType[type] ?? 0) > 0, `golden fixture 缺少 ${type} 层节点`);
    }
  });

  it('所有仓库事实都绑定固定 commit', async () => {
    const result = await validateBundle(GOLDEN, { only: ['PTKG006'] });
    assert.equal(result.findings.length, 0, 'golden fixture 不应有浮动 ref');
  });

  it('每个 competency 都有证据（PTKG004 无 blocker）', async () => {
    const result = await validateBundle(GOLDEN, { only: ['PTKG004'] });
    const blockers = result.findings.filter((f) => f.severity === 'blocker');
    assert.equal(blockers.length, 0);
  });

  it('课程范围锁定到项目先导准备度，不包含真实贡献责任', async () => {
    const { bundle } = await loadBundle(GOLDEN);
    assert.ok(bundle);
    const project = bundle.nodes.find((node) => node.type === 'project');

    assert.equal(project?.curriculum_scope?.mode, 'pre_project_readiness');
    assert.match(project?.curriculum_scope?.exit ?? '', /Project Readiness Gate/);

    assert.equal(
      Object.prototype.hasOwnProperty.call(project ?? {}, 'individual_minimum_contribution'),
      false,
    );
    assert.ok(
      project?.curriculum_scope?.excluded_responsibilities?.some((item) =>
        item.includes('个人最低贡献'),
      ),
      '应把个人贡献评价显式列为课程范围之外，而不是留下隐含歧义',
    );

    const learningArtifacts = bundle.nodes.filter(
      (node) => node.type === 'practice' || node.type === 'evidence',
    );
    const serializedLearningArtifacts = JSON.stringify(learningArtifacts);
    assert.doesNotMatch(serializedLearningArtifacts, /提交符合.*PR|PR 说明|上游合并/);
    assert.ok(
      learningArtifacts.every((node) => node.evidence_kind !== 'code_contribution'),
      '项目先导样例不得用真实代码贡献作为准备度证据',
    );
  });

  it('Generation Report 显示 Project Readiness Gate 与准备度标准', async () => {
    const result = await validateBundle(GOLDEN);
    const report = formatGenerationReport(result);
    assert.match(report, /课程模式：pre_project_readiness/);
    assert.match(report, /课程出口：Project Readiness Gate/);
    assert.match(report, /项目准备度标准/);
  });
});

describe('broken fixture：全部规则的触发验证', () => {
  it('每条规则码都至少触发一次', async () => {
    const result = await validateBundle(BROKEN, { staleAfterDays: 180 });
    const fired = new Set<RuleCode>(result.findings.map((f) => f.code));

    const missing = RULE_CODES.filter((code) => !fired.has(code));
    assert.deepEqual(
      missing,
      [],
      `以下规则未被 broken fixture 触发，等于没有测试覆盖：${missing.join(', ')}`,
    );
  });

  it('存在 blocker，拒绝发布', async () => {
    const result = await validateBundle(BROKEN);
    assert.equal(result.passed, false);
    assert.ok(result.summary.blocker > 0);
  });

  it('PTKG003 报出具体环路径而不只说「有环」', async () => {
    const result = await validateBundle(BROKEN, { only: ['PTKG003'] });
    const cycle = result.findings.find((f) => f.code === 'PTKG003');

    assert.ok(cycle, '应检出前置环');
    assert.ok(
      (cycle.subjects?.length ?? 0) >= 2,
      '环必须列出参与节点，教师才能定位是哪几个节点互相卡住',
    );
    assert.match(cycle.message, /→/, '环路径应可读');
  });

  it('just_in_time 边不算成环（协同学习不误报）', async () => {
    // broken fixture 里刻意放了一条 just_in_time 的回边，
    // 它不应被算成严格前置环——规范 Step 7 明确区分二者。
    const result = await validateBundle(BROKEN, { only: ['PTKG003'] });
    const subjects = result.findings.flatMap((f) => f.subjects ?? []);
    assert.ok(
      !subjects.some((s) => s.includes('jit-')),
      'just_in_time 关系被误判为严格前置环',
    );
  });
});

describe('规则筛选', () => {
  it('--only 只跑指定规则', async () => {
    const result = await validateBundle(BROKEN, { only: ['PTKG006'] });
    const codes = new Set(result.findings.map((f) => f.code));
    assert.deepEqual([...codes], ['PTKG006']);
  });

  it('--skip 跳过指定规则', async () => {
    const result = await validateBundle(BROKEN, { skip: ['PTKG001'] });
    const codes = new Set(result.findings.map((f) => f.code));
    assert.ok(!codes.has('PTKG001'));
    assert.ok(codes.size > 0, '跳过一条规则后仍应有其他发现');
  });
});

describe('不可绕过的边界', () => {
  it('PTKG006 只接受完整 40 位 commit，不接受常见 7 位缩写', () => {
    assert.equal(isFixedCommitRef('fc80b86'), false);
    assert.equal(isFixedCommitRef('fc80b868fb3640efe8997994de42c1aee8fd74cb'), true);
  });

  it('manifest.files 不能用 ../ 读取 bundle 外部文件', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ptkg-loader-'));
    const bundleDir = path.join(root, 'bundle');
    const { mkdir } = await import('node:fs/promises');

    try {
      await mkdir(bundleDir);
      await writeFile(
        path.join(bundleDir, 'manifest.yaml'),
        `ptkg_version: "0.1"\nbundle_id: ptkg.loader.escape\ntitle: traversal\nstatus: draft\nproject_ref:\n  repository_url: https://example.com/repo\n  git_ref: fc80b868fb3640efe8997994de42c1aee8fd74cb\nfiles:\n  nodes: ../outside.jsonl\n  edges: edges.jsonl\n  sources: sources.jsonl\n`,
      );
      await writeFile(path.join(root, 'outside.jsonl'), '{"id":"project.escape"}\n');
      await writeFile(path.join(bundleDir, 'edges.jsonl'), '');
      await writeFile(path.join(bundleDir, 'sources.jsonl'), '');

      const result = await loadBundle(bundleDir);
      assert.ok(
        result.findings.some(
          (f) => f.code === 'PTKG001' && f.message.includes('指向 bundle 外部'),
        ),
      );
      assert.equal(result.bundle?.nodes.length, 0, '不得读取 bundle 外的 outside.jsonl');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('确定性：同一输入必须得到同一输出', () => {
  it('连续两次校验产出完全相同的 findings 序列', async () => {
    const a = await validateBundle(BROKEN);
    const b = await validateBundle(BROKEN);

    // 这是「模型无关」的基础：不管谁生成 bundle，校验结果必须可复现，
    // 否则教师无法判断两个 Agent 谁的产物更好。
    assert.deepEqual(
      a.findings.map((f) => [f.code, f.subject, f.message]),
      b.findings.map((f) => [f.code, f.subject, f.message]),
    );
  });
});

describe('diff', () => {
  it('识别新增、删除与前置关系变化', async () => {
    const golden = await loadBundle(GOLDEN);
    const broken = await loadBundle(BROKEN);
    assert.ok(golden.bundle && broken.bundle);

    const result = diffBundles(golden.bundle, broken.bundle);

    assert.ok(result.summary.added > 0, '应检出新增节点');
    assert.ok(result.summary.removed > 0, '应检出删除节点');
  });

  it('同一 bundle 自比无变化', async () => {
    const { bundle } = await loadBundle(GOLDEN);
    assert.ok(bundle);

    const result = diffBundles(bundle, bundle);
    assert.equal(result.summary.added, 0);
    assert.equal(result.summary.removed, 0);
    assert.equal(result.summary.changed, 0);
  });
});

describe('loader 容错', () => {
  it('缺 manifest 时报 PTKG001 而不是抛异常', async () => {
    const result = await validateBundle(path.join(HERE, 'no-such-dir'));
    assert.equal(result.bundle, null);
    assert.ok(result.findings.some((f) => f.code === 'PTKG001'));
    assert.equal(result.passed, false);
  });
});
