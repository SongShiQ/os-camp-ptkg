import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { generateG5Fixtures } from '../scripts/generate-g5-fixtures.ts';
import { compileCourse } from '../src/course/compiler.ts';
import { canonicalJson, listPackageFiles, readCourseJsonl } from '../src/course/io.ts';
import { STARRYOS_SHARED_NODES } from '../src/course/shared.ts';
import type { CourseGate, CourseStage, CourseUnit } from '../src/course/types.ts';
import { validateCoursePackage } from '../src/course/validate.ts';
import type { PtkgNode } from '../src/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const fixtures = path.join(root, 'fixtures');
const cgroup = path.join(fixtures, 'authoring', 'cgroup-golden');
const abi = path.join(fixtures, 'authoring', 'starryos-abi-golden');
const rcore = path.join(fixtures, 'authoring', 'rcore-tutorial-smoke');

async function treeSnapshot(directory: string): Promise<Array<{ file: string; bytes: string }>> {
  const values: Array<{ file: string; bytes: string }> = [];
  async function visit(current: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full, relative);
      else if (entry.isFile()) values.push({ file: relative, bytes: (await readFile(full)).toString('base64') });
    }
  }
  await visit(directory, '');
  return values;
}

async function packageBytes(directory: string): Promise<Array<{ file: string; bytes: string }>> {
  return Promise.all((await listPackageFiles(directory)).map(async (file) => ({
    file,
    bytes: (await readFile(path.join(directory, file))).toString('base64'),
  })));
}

describe('G5 黄金课程与跨仓库 smoke', () => {
  it('G5 fixture 生成器可重放且不会产生漂移', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ptkg-g5-fixtures-'));
    await cp(cgroup, path.join(temp, 'authoring', 'cgroup-golden'), { recursive: true });
    await generateG5Fixtures(temp);
    assert.deepEqual(
      await treeSnapshot(path.join(temp, 'authoring', 'cgroup-golden')),
      await treeSnapshot(cgroup),
    );
    assert.deepEqual(
      await treeSnapshot(path.join(temp, 'authoring', 'starryos-abi-golden')),
      await treeSnapshot(abi),
    );
    assert.deepEqual(
      await treeSnapshot(path.join(temp, 'authoring', 'rcore-tutorial-smoke')),
      await treeSnapshot(rcore),
    );
    assert.equal(
      await readFile(path.join(temp, 'smoke', 'rcore-tutorial-v3-analysis.json'), 'utf8'),
      await readFile(path.join(fixtures, 'smoke', 'rcore-tutorial-v3-analysis.json'), 'utf8'),
    );
  });

  it('StarryOS ABI 完整候选课程确定性编译并覆盖 16 个工程域', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ptkg-g5-abi-'));
    const first = path.join(temp, 'first');
    const second = path.join(temp, 'second');
    const a = await compileCourse(abi, first);
    const b = await compileCourse(abi, second);
    assert.equal(a.checksums.root_hash, b.checksums.root_hash);
    assert.deepEqual(await packageBytes(first), await packageBytes(second));
    assert.deepEqual(a.counts, {
      nodes: 24, edges: 23, sources: 23, stages: 4, units: 16,
      questions: 64, practices: 16, gates: 17, cards: 16,
    });
    const validation = await validateCoursePackage(first, 'draft');
    assert.equal(validation.passed, true, validation.findings.map((item) => item.message).join('\n'));
    assert.equal(validation.summary.blocker, 0);

    const stages = await readCourseJsonl<CourseStage>(first, 'course/stages.jsonl');
    const units = await readCourseJsonl<CourseUnit>(first, 'course/units.jsonl');
    const gates = await readCourseJsonl<CourseGate>(first, 'course/gates.jsonl');
    assert.equal(stages.find((item) => item.layer === 'project_reference')?.unit_ids.length, 0);
    const readiness = gates.find((item) => item.id === 'gate.starryos.abi.project-readiness');
    assert.ok(readiness);
    assert.deepEqual([...readiness.unit_ids].sort(), units.map((item) => item.id).sort());
    assert.deepEqual([...readiness.prerequisite_gate_ids].sort(), gates.filter((item) => item.id !== readiness.id).map((item) => item.id).sort());
    assert.match(readiness.pass_policy, /不得据此分配或评价真实项目贡献/);
  });

  it('cgroup 与 ABI 精确复用同一组 StarryOS canonical nodes', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ptkg-g5-shared-'));
    const cgroupPackage = path.join(temp, 'cgroup');
    const abiPackage = path.join(temp, 'abi');
    await compileCourse(cgroup, cgroupPackage);
    await compileCourse(abi, abiPackage);
    const expected = new Map(STARRYOS_SHARED_NODES.map((item) => [item.id, canonicalJson(item)]));
    for (const directory of [cgroupPackage, abiPackage]) {
      const nodes = await readCourseJsonl<PtkgNode>(directory, 'graph/nodes.jsonl');
      const actual = new Map(nodes.filter((item) => expected.has(item.id)).map((item) => [item.id, canonicalJson(item)]));
      assert.deepEqual(actual, expected);
    }
  });

  it('rCore-Tutorial-v3 真仓库分析证据可编译为最小跨仓库 smoke', async () => {
    const evidence = JSON.parse(await readFile(path.join(fixtures, 'smoke', 'rcore-tutorial-v3-analysis.json'), 'utf8')) as {
      commit: string; tree: string; facts: { total: number; unresolved: number }; anchors: { total: number; verified: number; unresolved: number }; boundary: string;
    };
    assert.equal(evidence.commit, 'c91bd3752b53ff48555aef4e3c7b8d5ddc8ee6e1');
    assert.equal(evidence.tree, 'f649d5b69c790b85ea323edc5c9d02afbbb66104');
    assert.deepEqual(evidence.facts, { candidate: 1018, total: 1023, unresolved: 5 });
    assert.deepEqual(evidence.anchors, { total: 1018, unresolved: 62, verified: 956 });
    assert.equal(evidence.boundary, 'analysis_and_compile_smoke_only');

    const temp = await mkdtemp(path.join(tmpdir(), 'ptkg-g5-rcore-'));
    const output = path.join(temp, 'package');
    const compiled = await compileCourse(rcore, output);
    assert.deepEqual(compiled.counts, {
      nodes: 7, edges: 6, sources: 4, stages: 2, units: 1,
      questions: 4, practices: 1, gates: 1, cards: 1,
    });
    const validation = await validateCoursePackage(output, 'draft');
    assert.equal(validation.passed, true, validation.findings.map((item) => item.message).join('\n'));
    assert.equal(validation.summary.blocker, 0);
    const card = await readFile(path.join(output, 'content', 'cards', 'card.rcore.analysis-smoke.md'), 'utf8');
    assert.match(card, /不冒充完整 rCore 课程/);
  });
});
