import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { cp, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import YAML from 'yaml';

import { compileCourse } from '../src/course/compiler.ts';
import {
  canonicalJson,
  canonicalJsonl,
  computeCourseChecksums,
  computeCourseContentHash,
  listPackageFiles,
  parseCard,
  readCourseJsonl,
  renderCard,
} from '../src/course/io.ts';
import { packCoursePackage } from '../src/course/pack.ts';
import { signCoursePackage } from '../src/course/sign.ts';
import type {
  CourseCard,
  CourseGate,
  CoursePractice,
  CourseQuestion,
  CourseStage,
  CourseUnit,
} from '../src/course/types.ts';
import { validateCoursePackage } from '../src/course/validate.ts';
import type { PtkgEdge, PtkgNode } from '../src/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const fixture = path.join(root, 'fixtures', 'authoring', 'cgroup-golden');

async function compileFixture(label: string): Promise<{ temp: string; workspace: string; packageDir: string }> {
  const temp = await mkdtemp(path.join(tmpdir(), `ptkg-${label}-`));
  const workspace = path.join(temp, 'workspace');
  const packageDir = path.join(temp, 'package');
  await cp(fixture, workspace, { recursive: true });
  await compileCourse(workspace, packageDir);
  return { temp, workspace, packageDir };
}

async function packageSnapshot(directory: string): Promise<Array<{ file: string; bytes: string }>> {
  const files = await listPackageFiles(directory);
  return Promise.all(files.map(async (file) => ({
    file,
    bytes: (await readFile(path.join(directory, file))).toString('base64'),
  })));
}

async function rewriteChecksums(directory: string): Promise<void> {
  const checksums = await computeCourseChecksums(directory);
  await writeFile(path.join(directory, 'checksums.json'), `${canonicalJson(checksums)}\n`, 'utf8');
}

async function reviewCoursePackage(directory: string): Promise<void> {
  const rewriteGraph = async <T extends PtkgNode | PtkgEdge>(relative: string): Promise<void> => {
    const rows = await readCourseJsonl<T>(directory, relative);
    await writeFile(path.join(directory, relative), canonicalJsonl(rows.map((row) => ({ ...row, status: 'approved' }))), 'utf8');
  };
  await rewriteGraph<PtkgNode>('graph/nodes.jsonl');
  await rewriteGraph<PtkgEdge>('graph/edges.jsonl');

  const rewriteAssets = async <T extends { id: string; status: string; content_hash: string }>(relative: string): Promise<void> => {
    const rows = await readCourseJsonl<T>(directory, relative);
    const reviewed = rows.map((row) => {
      const value = { ...row, status: 'reviewed', content_hash: '' };
      return { ...value, content_hash: computeCourseContentHash(value) };
    });
    await writeFile(path.join(directory, relative), canonicalJsonl(reviewed), 'utf8');
  };
  await rewriteAssets<CourseStage>('course/stages.jsonl');
  await rewriteAssets<CourseUnit>('course/units.jsonl');
  await rewriteAssets<CourseQuestion>('course/questions.jsonl');
  await rewriteAssets<CoursePractice>('course/practices.jsonl');
  await rewriteAssets<CourseGate>('course/gates.jsonl');

  for (const file of (await listPackageFiles(directory)).filter((item) => item.startsWith('content/cards/'))) {
    const card = parseCard(await readFile(path.join(directory, file), 'utf8'), file);
    const value: CourseCard = { ...card, status: 'reviewed', content_hash: '' };
    value.content_hash = computeCourseContentHash(value);
    await writeFile(path.join(directory, file), renderCard(value), 'utf8');
  }
  await rewriteChecksums(directory);
}

async function createSigningIdentity(temp: string, actor: string): Promise<{ key: string; trust: string }> {
  const pair = generateKeyPairSync('ed25519');
  const key = path.join(temp, 'teacher.pk8.pem');
  await writeFile(key, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const trust = path.join(temp, 'trust.yaml');
  await writeFile(trust, YAML.stringify({
    spec_version: 'ptkg-trust-store@1',
    keys: [{ actor, public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
  }, { lineWidth: 0 }), 'utf8');
  return { key, trust };
}

describe('G2/G3 Course Package', () => {
  it('同一作者工作区重复编译逐字节一致，draft 质量门通过', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ptkg-course-determinism-'));
    const workspace = path.join(temp, 'workspace');
    await cp(fixture, workspace, { recursive: true });
    const first = path.join(temp, 'first');
    const second = path.join(temp, 'second');
    const a = await compileCourse(workspace, first);
    const b = await compileCourse(workspace, second);
    assert.equal(a.checksums.root_hash, b.checksums.root_hash);
    assert.deepEqual(await packageSnapshot(first), await packageSnapshot(second));
    const validation = await validateCoursePackage(first, 'draft');
    assert.equal(validation.passed, true);
    assert.equal(validation.summary.blocker, 0);
    assert.ok(validation.findings.some((item) => item.code === 'COURSE008' && item.severity === 'review'));
  });

  it('内容篡改、checksum 路径穿越和符号链接被 COURSE002 阻止', async (t) => {
    const { packageDir } = await compileFixture('tamper');
    await writeFile(path.join(packageDir, 'course', 'questions.jsonl'), '\n', { flag: 'a' });
    let result = await validateCoursePackage(packageDir, 'draft');
    assert.ok(result.findings.some((item) => item.code === 'COURSE002' && item.severity === 'blocker'));

    const checksumsFile = path.join(packageDir, 'checksums.json');
    const checksums = JSON.parse(await readFile(checksumsFile, 'utf8')) as { files: Array<{ path: string }> };
    if (checksums.files[0]) checksums.files[0].path = '../outside';
    await writeFile(checksumsFile, `${canonicalJson(checksums)}\n`, 'utf8');
    result = await validateCoursePackage(packageDir, 'draft');
    assert.ok(result.findings.some((item) => item.code === 'COURSE002' && item.subject === '../outside'));

    try {
      await symlink(path.join(packageDir, 'manifest.yaml'), path.join(packageDir, 'linked-manifest.yaml'));
      result = await validateCoursePackage(packageDir, 'draft');
      assert.ok(result.findings.some((item) => item.code === 'COURSE002' && /符号链接/.test(item.message)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') t.diagnostic('当前 Windows 环境未授予创建符号链接权限；路径遍历门仍已验证。');
      else throw error;
    }
  });

  it('缺少双题组资产时 COURSE005 阻止 draft', async () => {
    const { packageDir } = await compileFixture('question-pools');
    const units = await readCourseJsonl<CourseUnit>(packageDir, 'course/units.jsonl');
    const unit = units[0];
    assert.ok(unit);
    unit.question_ids = unit.question_ids.slice(0, 2);
    unit.content_hash = computeCourseContentHash(unit);
    await writeFile(path.join(packageDir, 'course', 'units.jsonl'), canonicalJsonl(units), 'utf8');
    await rewriteChecksums(packageDir);
    const validation = await validateCoursePackage(packageDir, 'draft');
    assert.equal(validation.passed, false);
    assert.ok(validation.findings.some((item) => item.code === 'COURSE005'));
  });

  it('COURSE001/003/004/006/007/009/010/012 各自有可执行反例', async () => {
    const { temp, packageDir } = await compileFixture('rule-coverage');
    const cases: Array<{
      code: string;
      mutate(directory: string): Promise<void>;
    }> = [
      {
        code: 'COURSE001',
        async mutate(directory) {
          const units = await readCourseJsonl<Record<string, unknown> & { id: string }>(directory, 'course/units.jsonl');
          delete units[0]?.title;
          if (units[0]) units[0].content_hash = computeCourseContentHash(units[0]);
          await writeFile(path.join(directory, 'course', 'units.jsonl'), canonicalJsonl(units), 'utf8');
        },
      },
      {
        code: 'COURSE003',
        async mutate(directory) {
          const stages = await readCourseJsonl<CourseStage>(directory, 'course/stages.jsonl');
          if (stages[0]) {
            stages[0].prerequisite_stage_ids = [stages[0].id];
            stages[0].content_hash = computeCourseContentHash(stages[0]);
          }
          await writeFile(path.join(directory, 'course', 'stages.jsonl'), canonicalJsonl(stages), 'utf8');
        },
      },
      {
        code: 'COURSE004',
        async mutate(directory) {
          const units = await readCourseJsonl<CourseUnit>(directory, 'course/units.jsonl');
          if (units[0]) {
            units[0].card_ids = [];
            units[0].content_hash = computeCourseContentHash(units[0]);
          }
          await writeFile(path.join(directory, 'course', 'units.jsonl'), canonicalJsonl(units), 'utf8');
        },
      },
      {
        code: 'COURSE006',
        async mutate(directory) {
          const practices = await readCourseJsonl<CoursePractice>(directory, 'course/practices.jsonl');
          if (practices[0]) {
            practices[0].expected_evidence = [];
            practices[0].content_hash = computeCourseContentHash(practices[0]);
          }
          await writeFile(path.join(directory, 'course', 'practices.jsonl'), canonicalJsonl(practices), 'utf8');
        },
      },
      {
        code: 'COURSE007',
        async mutate(directory) {
          const manifestFile = path.join(directory, 'manifest.yaml');
          const manifest = YAML.parse(await readFile(manifestFile, 'utf8')) as { project_ref: { commit: string } };
          manifest.project_ref.commit = 'main';
          await writeFile(manifestFile, YAML.stringify(manifest, { lineWidth: 0 }), 'utf8');
        },
      },
      {
        code: 'COURSE009',
        async mutate(directory) {
          const units = await readCourseJsonl<CourseUnit>(directory, 'course/units.jsonl');
          if (units[0]) {
            units[0].origin_projects = [units[0].origin_projects[0] ?? 'project.example', units[0].origin_projects[0] ?? 'project.example'];
            units[0].content_hash = computeCourseContentHash(units[0]);
          }
          await writeFile(path.join(directory, 'course', 'units.jsonl'), canonicalJsonl(units), 'utf8');
        },
      },
      {
        code: 'COURSE010',
        async mutate(directory) {
          const file = path.join(directory, 'content', 'cards', 'card.starryos.cgroup.pids-vertical.md');
          const card = parseCard(await readFile(file, 'utf8'), 'content/cards/card.starryos.cgroup.pids-vertical.md');
          card.body += '\n\nC:\\Users\\teacher\\private-note.md';
          card.content_hash = computeCourseContentHash(card);
          await writeFile(file, renderCard(card), 'utf8');
        },
      },
      {
        code: 'COURSE012',
        async mutate(directory) {
          const file = path.join(directory, 'projections', 'dream-agent-v1.json');
          const projection = JSON.parse(await readFile(file, 'utf8')) as { unit_ids: string[] };
          projection.unit_ids = [];
          await writeFile(file, `${canonicalJson(projection)}\n`, 'utf8');
        },
      },
    ];
    for (const [index, item] of cases.entries()) {
      const directory = path.join(temp, `case-${index}`);
      await cp(packageDir, directory, { recursive: true });
      await item.mutate(directory);
      await rewriteChecksums(directory);
      const validation = await validateCoursePackage(directory, 'draft');
      assert.ok(validation.findings.some((finding) => finding.code === item.code), `${item.code} 未触发`);
    }
  });

  it('候选内容和不可信签名不能 release，可信教师签名可通过', async () => {
    const { temp, packageDir } = await compileFixture('signature');
    const identity = await createSigningIdentity(temp, 'teacher.chen');
    let validation = await validateCoursePackage(packageDir, 'release', { trustStore: identity.trust });
    assert.equal(validation.passed, false);
    assert.ok(validation.findings.some((item) => item.code === 'COURSE008'));
    assert.ok(validation.findings.some((item) => item.code === 'COURSE011'));

    await reviewCoursePackage(packageDir);
    const signed = await signCoursePackage(packageDir, identity.key, 'teacher.chen');
    assert.match(signed.attestation.key_fingerprint, /^sha256:[0-9a-f]{64}$/);
    validation = await validateCoursePackage(packageDir, 'release', { trustStore: identity.trust });
    assert.equal(validation.passed, true, validation.findings.map((item) => item.message).join('\n'));

    const stranger = await createSigningIdentity(path.join(temp), 'teacher.other');
    validation = await validateCoursePackage(packageDir, 'release', { trustStore: stranger.trust });
    assert.equal(validation.passed, false);
    assert.ok(validation.findings.some((item) => item.code === 'COURSE011'));
  });

  it('release 归档逐字节确定，签名后篡改无法归档', async () => {
    const { temp, packageDir } = await compileFixture('archive');
    const identity = await createSigningIdentity(temp, 'teacher.release');
    await reviewCoursePackage(packageDir);
    await signCoursePackage(packageDir, identity.key, 'teacher.release');
    const first = path.join(temp, 'first.tgz');
    const second = path.join(temp, 'second.tgz');
    await packCoursePackage(packageDir, first, identity.trust);
    await packCoursePackage(packageDir, second, identity.trust);
    assert.deepEqual(await readFile(first), await readFile(second));

    await writeFile(path.join(packageDir, 'content', 'cards', 'card.starryos.cgroup.pids-vertical.md'), '\n篡改\n', { flag: 'a' });
    await assert.rejects(() => packCoursePackage(packageDir, path.join(temp, 'tampered.tgz'), identity.trust), /COURSE002/);
  });
});
