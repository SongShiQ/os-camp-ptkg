import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import type { CourseAttestation, CourseSignResult } from './types.ts';
import { canonicalJson, computeCourseChecksums, loadCoursePackage } from './io.ts';
import { createCourseAttestation } from './signature.ts';
import { validateCoursePackage } from './validate.ts';

function attestationsJsonl(values: CourseAttestation[]): string {
  const sorted = [...values].sort((a, b) => (
    a.actor.localeCompare(b.actor)
    || a.key_fingerprint.localeCompare(b.key_fingerprint)
    || a.root_hash.localeCompare(b.root_hash)
  ));
  return sorted.length === 0 ? '' : `${sorted.map(canonicalJson).join('\n')}\n`;
}

export async function signCoursePackage(
  directory: string,
  keyFile: string,
  actor: string,
): Promise<CourseSignResult> {
  if (!actor.trim()) throw new Error('教师 actor 不能为空。');
  const root = path.resolve(directory);
  const manifestFile = path.join(root, 'manifest.yaml');
  const checksumsFile = path.join(root, 'checksums.json');
  const originalManifest = await readFile(manifestFile, 'utf8');
  const originalChecksums = await readFile(checksumsFile, 'utf8');
  const attestationsFile = path.join(root, 'governance', 'attestations.jsonl');
  const originalAttestations = await readFile(attestationsFile, 'utf8');
  const loaded = await loadCoursePackage(root);
  if (!loaded.package) throw new Error(`课程包无法载入：${loaded.findings.map((item) => item.message).join('；')}`);

  const manifest = { ...loaded.package.manifest, package_status: 'release' as const };
  try {
    await writeFile(manifestFile, YAML.stringify(manifest, { lineWidth: 0 }), 'utf8');
    const checksums = await computeCourseChecksums(root);
    await writeFile(checksumsFile, `${canonicalJson(checksums)}\n`, 'utf8');
    const preflight = await validateCoursePackage(root, 'release', { skipSignature: true });
    if (!preflight.passed) {
      throw new Error(`课程尚不满足 release 签名前置条件：${preflight.findings
        .filter((item) => item.severity === 'blocker')
        .map((item) => `${item.code} ${item.subject}`)
        .join('；')}`);
    }
    const privateKeyPem = await readFile(keyFile, 'utf8');
    const attestation = createCourseAttestation({
      privateKeyPem,
      actor: actor.trim(),
      rootHash: checksums.root_hash,
      courseId: manifest.course_id,
      version: manifest.version,
    });
    const existing = loaded.package.attestations.filter((item) => (
      item.actor !== attestation.actor || item.key_fingerprint !== attestation.key_fingerprint
    ));
    await writeFile(
      attestationsFile,
      attestationsJsonl([...existing, attestation]),
      'utf8',
    );
    return { package_dir: root, attestation };
  } catch (error) {
    await Promise.all([
      writeFile(manifestFile, originalManifest, 'utf8'),
      writeFile(checksumsFile, originalChecksums, 'utf8'),
      writeFile(attestationsFile, originalAttestations, 'utf8'),
    ]);
    throw error;
  }
}
