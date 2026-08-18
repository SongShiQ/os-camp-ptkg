import { loadCoursePackage } from '../io.ts';
import { canonicalJson, sha256 } from '../io.ts';

export interface CourseV1MigrationObject {
  source_id: string;
  target_kind: 'practice' | 'gate' | 'source_contract' | 'assertion' | 'evidence';
  status: 'candidate' | 'unresolved';
  missing_fields: string[];
  notes: string[];
}

export interface CourseV1MigrationReport {
  spec_version: 'course-v1-to-v2-migration@1';
  source_contract: 'os-camp-course@1';
  target_contract: 'os-camp-course@2';
  course_id: string | null;
  version: string | null;
  derived_source_contract_root: string | null;
  objects: CourseV1MigrationObject[];
  blocker_count: number;
}

/**
 * @1 → @2 只生成缺口报告，不把旧的 trusted_evidence 或自然语言 expected_evidence
 * 冒充成 typed assertion / release receipt。教师补齐报告中的缺口后，再走正常 v2 compiler。
 */
export async function inspectCourseV1Migration(directory: string): Promise<CourseV1MigrationReport> {
  const loaded = await loadCoursePackage(directory);
  if (!loaded.package) {
    return {
      spec_version: 'course-v1-to-v2-migration@1',
      source_contract: 'os-camp-course@1',
      target_contract: 'os-camp-course@2',
      course_id: null,
      version: null,
      derived_source_contract_root: null,
      objects: [{
        source_id: 'package',
        target_kind: 'source_contract',
        status: 'unresolved',
        missing_fields: ['valid os-camp-course@1 package'],
        notes: loaded.findings.map((item) => item.message),
      }],
      blocker_count: 1,
    };
  }
  const pkg = loaded.package;
  const sourceIdentity = {
    repo: pkg.manifest.project_ref.repo,
    commit: pkg.manifest.project_ref.commit,
    tree: pkg.manifest.project_ref.tree,
  };
  const sourceRoot = sha256(`migration-source-contract@1\0${canonicalJson(sourceIdentity)}`);
  const objects: CourseV1MigrationObject[] = [];
  for (const practice of pkg.practices) {
    objects.push({
      source_id: practice.id,
      target_kind: 'practice',
      status: 'unresolved',
      missing_fields: [
        'source_contract_and_verified_anchor',
        'source_continuity',
        'structured_change_policy',
        'typed_assertion_ids_and_oracles',
        'trusted_execution_environment_and_reset',
        'teacher_review_and_visibility',
      ],
      notes: ['旧 practices.expected_evidence 只作为候选提示，不能直接升级为 Assertion Definition。'],
    });
    objects.push({
      source_id: `${practice.id}.assertions`,
      target_kind: 'assertion',
      status: 'unresolved',
      missing_fields: ['typed assertion class', 'oracle', 'trusted producer', 'content hash'],
      notes: ['@1 没有可证明的 assertion identity。'],
    });
    objects.push({
      source_id: `${practice.id}.evidence`,
      target_kind: 'evidence',
      status: 'unresolved',
      missing_fields: ['release receipt', 'environment digest', 'reset evidence', 'artifact hashes'],
      notes: ['@1 的 expected_evidence 不是真实执行收据。'],
    });
  }
  for (const gate of pkg.gates) {
    objects.push({
      source_id: gate.id,
      target_kind: 'gate',
      status: 'unresolved',
      missing_fields: ['required assertion IDs', 'allowed evidence purposes/producers', 'trust roots', 'expiry policy'],
      notes: ['trusted_evidence 布尔值不迁移为 @2 gate policy。'],
    });
  }
  objects.push({
    source_id: 'manifest.project_ref',
    target_kind: 'source_contract',
    status: 'unresolved',
    missing_fields: ['authoring source-contract root', 'verified tree projection', 'composition manifest'],
    notes: ['派生 root 仅用于追踪迁移输入，不能作为已验证源码合同。'],
  });
  return {
    spec_version: 'course-v1-to-v2-migration@1',
    source_contract: 'os-camp-course@1',
    target_contract: 'os-camp-course@2',
    course_id: pkg.manifest.course_id,
    version: pkg.manifest.version,
    derived_source_contract_root: sourceRoot,
    objects: objects.sort((a, b) => a.source_id.localeCompare(b.source_id) || a.target_kind.localeCompare(b.target_kind)),
    blocker_count: objects.length,
  };
}
