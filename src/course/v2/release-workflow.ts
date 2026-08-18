import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import type { CourseFinding, CourseTrustKey } from '../types.ts';
import { canonicalJson } from '../io.ts';
import { loadCourseTrustStore } from '../signature.ts';
import {
  computeCourseV2Checksums,
  loadCourseV2Package,
  validateCourseV2Package,
} from './package.ts';
import {
  computeTeacherOverlayIndex,
  createReleaseSet,
  loadTeacherOverlayManifest,
  signReleaseSet,
  validateOverlayRequirement,
  validateReleaseSet,
  validateReleaseSetSchemas,
  validateTeacherOverlayManifest,
} from './release-set.ts';
import type {
  ReleaseSetV1,
  TeacherOverlayIndexV1,
  TeacherOverlayManifestV1,
} from './types.ts';

function finding(code: CourseFinding['code'], subject: string, message: string): CourseFinding {
  return { code, severity: 'blocker', subject, message };
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface SignCourseV2ReleaseResult {
  package_dir: string;
  public_package_root: string;
  teacher_overlay_root: string | null;
  release_set_file: string;
  release_set: ReleaseSetV1;
}

export async function signCourseV2Release(input: {
  packageDir: string;
  overlayDir?: string;
  outputFile: string;
  keyFile: string;
  actor: string;
  trustStoreId: string;
}): Promise<SignCourseV2ReleaseResult> {
  const packageRoot = path.resolve(input.packageDir);
  const output = path.resolve(input.outputFile);
  const overlayRoot = input.overlayDir ? path.resolve(input.overlayDir) : null;
  if (inside(packageRoot, output) || (overlayRoot && inside(overlayRoot, output))) {
    throw new Error('release-set.json 必须位于公开包和教师 overlay 之外，否则会改变已签 root。');
  }
  if (await stat(output).catch(() => null)) throw new Error(`Release Set 输出已存在：${output}`);
  const loaded = await loadCourseV2Package(packageRoot);
  if (!loaded.package) throw new Error(`Course v2 无法载入：${loaded.findings.map((item) => item.message).join('；')}`);
  const manifestFile = path.join(packageRoot, 'manifest.yaml');
  const checksumsFile = path.join(packageRoot, 'checksums.json');
  const originalManifest = await readFile(manifestFile, 'utf8');
  const originalChecksums = await readFile(checksumsFile, 'utf8');
  const overlayManifestFile = overlayRoot ? path.join(overlayRoot, 'manifest.yaml') : null;
  const overlayIndexFile = overlayRoot ? path.join(overlayRoot, 'overlay-index.json') : null;
  const originalOverlayManifest = overlayManifestFile
    ? await readFile(overlayManifestFile, 'utf8').catch(() => null)
    : null;
  const originalOverlayIndex = overlayIndexFile
    ? await readFile(overlayIndexFile, 'utf8').catch(() => null)
    : null;
  try {
    const manifest = { ...loaded.package.manifest, package_status: 'release' as const };
    await writeFile(manifestFile, YAML.stringify(manifest, { lineWidth: 0 }), 'utf8');
    const checksums = await computeCourseV2Checksums(packageRoot);
    await writeFile(checksumsFile, `${canonicalJson(checksums)}\n`, 'utf8');
    const validation = await validateCourseV2Package(packageRoot, 'release');
    if (!validation.passed || !validation.package) {
      throw new Error(`Course v2 不满足发布条件：${validation.findings.map((item) => `${item.code} ${item.subject}`).join('；')}`);
    }

    let overlayIndex: TeacherOverlayIndexV1 | null = null;
    let boundOverlayManifest: TeacherOverlayManifestV1 | undefined;
    if (overlayRoot && overlayManifestFile && overlayIndexFile) {
      const current = await loadTeacherOverlayManifest(overlayRoot);
      const bound: TeacherOverlayManifestV1 = {
        ...current,
        course_id: manifest.course_id,
        version: manifest.version,
        public_package_root: checksums.root_hash,
        source_composition_root: manifest.source_composition_root,
      };
      boundOverlayManifest = bound;
      await writeFile(overlayManifestFile, YAML.stringify(bound, { lineWidth: 0 }), 'utf8');
      overlayIndex = await computeTeacherOverlayIndex(overlayRoot);
      await writeFile(overlayIndexFile, `${canonicalJson(overlayIndex)}\n`, 'utf8');
      const overlayFindings = validateTeacherOverlayManifest(bound, {
        courseId: manifest.course_id,
        version: manifest.version,
        publicPackageRoot: checksums.root_hash,
        sourceCompositionRoot: manifest.source_composition_root,
      });
      if (overlayFindings.length > 0) {
        throw new Error(`教师 overlay 无法绑定：${overlayFindings.map((item) => item.message).join('；')}`);
      }
    }

    let releaseSet = createReleaseSet({
      courseId: manifest.course_id,
      version: manifest.version,
      publicPackageRoot: checksums.root_hash,
      teacherOverlayRoot: overlayIndex?.root_hash ?? null,
      sourceCompositionRoot: manifest.source_composition_root,
      trustStoreId: input.trustStoreId,
    });
    const overlayRequirements = validateOverlayRequirement(
      releaseSet,
      validation.package.practices,
      validation.package.assertions,
    );
    if (overlayRequirements.length > 0) {
      throw new Error(`课程需要教师私有 overlay：${overlayRequirements.map((item) => item.message).join('；')}`);
    }
    releaseSet = signReleaseSet(
      releaseSet,
      await readFile(input.keyFile, 'utf8'),
      input.actor,
    );
    const schemaFindings = await validateReleaseSetSchemas({
      releaseSet,
      overlayManifest: boundOverlayManifest,
      overlayIndex: overlayIndex ?? undefined,
    });
    if (schemaFindings.length > 0) {
      throw new Error(`Release Set Schema 无效：${schemaFindings.map((item) => item.message).join('；')}`);
    }
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${canonicalJson(releaseSet)}\n`, { encoding: 'utf8', flag: 'wx' });
    return {
      package_dir: packageRoot,
      public_package_root: checksums.root_hash,
      teacher_overlay_root: overlayIndex?.root_hash ?? null,
      release_set_file: output,
      release_set: releaseSet,
    };
  } catch (error) {
    await Promise.all([
      writeFile(manifestFile, originalManifest, 'utf8'),
      writeFile(checksumsFile, originalChecksums, 'utf8'),
      ...(overlayManifestFile && originalOverlayManifest !== null
        ? [writeFile(overlayManifestFile, originalOverlayManifest, 'utf8')]
        : []),
      ...(overlayIndexFile && originalOverlayIndex !== null
        ? [writeFile(overlayIndexFile, originalOverlayIndex, 'utf8')]
        : []),
    ]);
    if (overlayIndexFile && originalOverlayIndex === null) await unlink(overlayIndexFile).catch(() => undefined);
    await unlink(output).catch(() => undefined);
    throw error;
  }
}

export interface VerifyCourseV2ReleaseResult {
  passed: boolean;
  release_set: ReleaseSetV1 | null;
  findings: CourseFinding[];
}

export async function verifyCourseV2Release(input: {
  releaseSetFile: string;
  packageDir: string;
  overlayDir?: string;
  trustStoreFile: string;
}): Promise<VerifyCourseV2ReleaseResult> {
  const findings: CourseFinding[] = [];
  let releaseSet: ReleaseSetV1;
  try {
    releaseSet = JSON.parse(await readFile(path.resolve(input.releaseSetFile), 'utf8')) as ReleaseSetV1;
  } catch (error) {
    return { passed: false, release_set: null, findings: [finding('COURSE011', 'release-set', (error as Error).message)] };
  }
  const course = await validateCourseV2Package(input.packageDir, 'release');
  findings.push(...course.findings);
  if (!course.package) return { passed: false, release_set: releaseSet, findings };
  const publicRoot = course.package.checksums.root_hash;
  let overlayRoot: string | null = null;
  let overlayManifest: TeacherOverlayManifestV1 | undefined;
  let overlayIndex: TeacherOverlayIndexV1 | undefined;
  if (input.overlayDir) {
    try {
      overlayManifest = await loadTeacherOverlayManifest(input.overlayDir);
      overlayIndex = await computeTeacherOverlayIndex(input.overlayDir);
      overlayRoot = overlayIndex.root_hash;
      findings.push(...validateTeacherOverlayManifest(overlayManifest, {
        courseId: course.package.manifest.course_id,
        version: course.package.manifest.version,
        publicPackageRoot: publicRoot,
        sourceCompositionRoot: course.package.manifest.source_composition_root,
      }).map((item) => finding('COURSE011', item.subject, item.message)));
    } catch (error) {
      findings.push(finding('COURSE011', 'teacher-overlay', (error as Error).message));
    }
  }
  findings.push(...(await validateReleaseSetSchemas({ releaseSet, overlayManifest, overlayIndex }))
    .map((item) => finding('COURSE011', item.subject, item.message)));
  let trustKeys: CourseTrustKey[] = [];
  try {
    trustKeys = (await loadCourseTrustStore(input.trustStoreFile))?.keys ?? [];
  } catch (error) {
    findings.push(finding('COURSE011', 'trust-store', (error as Error).message));
  }
  findings.push(...validateReleaseSet(releaseSet, {
    publicPackageRoot: publicRoot,
    teacherOverlayRoot: overlayRoot,
    sourceCompositionRoot: course.package.manifest.source_composition_root,
    trustKeys,
  }).map((item) => finding('COURSE011', item.subject, item.message)));
  findings.push(...validateOverlayRequirement(
    releaseSet,
    course.package.practices,
    course.package.assertions,
  ).map((item) => finding('COURSE011', item.subject, item.message)));
  if (releaseSet.course_id !== course.package.manifest.course_id
    || releaseSet.version !== course.package.manifest.version) {
    findings.push(finding('COURSE011', releaseSet.course_id, 'Release Set 的课程身份与公开包不一致。'));
  }
  return { passed: findings.every((item) => item.severity !== 'blocker'), release_set: releaseSet, findings };
}
