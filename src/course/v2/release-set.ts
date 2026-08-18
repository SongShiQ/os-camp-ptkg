import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import YAML from 'yaml';

import type { CourseTrustKey } from '../types.ts';
import {
  canonicalJson,
  listPackageFiles,
  safeCoursePath,
  sha256,
} from '../io.ts';
import type {
  PracticeDefinitionV2,
  AssertionDefinitionV1,
  ReleaseSetAttestationV1,
  ReleaseSetV1,
  TeacherOverlayIndexV1,
  TeacherOverlayManifestV1,
} from './types.ts';
import type { ContractIssue } from './contracts.ts';

const OVERLAY_INDEX_FILE = 'overlay-index.json';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELEASE_SCHEMA = path.join(HERE, '..', '..', '..', 'schema', 'course', 'release-set@1.schema.json');
let releaseSchemaValidators: Record<string, ValidateFunction> | null = null;

function releaseIssue(subject: string, message: string): ContractIssue {
  return { code: 'F1-RELEASE', subject, message };
}

async function getReleaseSchemaValidators(): Promise<Record<string, ValidateFunction>> {
  if (releaseSchemaValidators) return releaseSchemaValidators;
  const schema = JSON.parse(await readFile(RELEASE_SCHEMA, 'utf8')) as Record<string, unknown>;
  const id = String(schema.$id);
  const ajv = new Ajv({ allErrors: true, strict: false, formats: { 'date-time': true } });
  ajv.addSchema(schema);
  releaseSchemaValidators = Object.fromEntries(['releaseSet', 'overlayManifest', 'overlayIndex'].map((name) => [
    name,
    ajv.compile({ $ref: `${id}#/$defs/${name}` }),
  ]));
  return releaseSchemaValidators;
}

export async function validateReleaseSetSchemas(input: {
  releaseSet: ReleaseSetV1;
  overlayManifest?: TeacherOverlayManifestV1;
  overlayIndex?: TeacherOverlayIndexV1;
}): Promise<ContractIssue[]> {
  const validators = await getReleaseSchemaValidators();
  const findings: ContractIssue[] = [];
  const apply = (name: string, value: unknown, subject: string): void => {
    const validator = validators[name];
    if (!validator || validator(value)) return;
    for (const error of validator.errors ?? [] as ErrorObject[]) {
      findings.push(releaseIssue(subject, `${error.instancePath || '根对象'} ${error.message ?? '不符合 Release Set Schema'}。`));
    }
  };
  apply('releaseSet', input.releaseSet, input.releaseSet.course_id);
  if (input.overlayManifest) apply('overlayManifest', input.overlayManifest, input.overlayManifest.course_id);
  if (input.overlayIndex) apply('overlayIndex', input.overlayIndex, 'teacher-overlay-index');
  return findings;
}

function fingerprint(publicKey: string | KeyObject): string {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  return `sha256:${sha256(key.export({ type: 'spki', format: 'der' }))}`;
}

export function releaseSetPayload(rootHash: string, courseId: string, version: string): Buffer {
  return Buffer.from(`os-camp-release-set@1\0${canonicalJson({
    course_id: courseId,
    release_set_root: rootHash,
    version,
  })}`, 'utf8');
}

export function computeReleaseSetRoot(value: Omit<ReleaseSetV1, 'release_set_root' | 'attestations'>): string {
  return sha256(`os-camp-release-set@1\0${canonicalJson(value)}`);
}

export function createReleaseSet(input: {
  courseId: string;
  version: string;
  publicPackageRoot: string;
  teacherOverlayRoot: string | null;
  sourceCompositionRoot: string;
  trustStoreId: string;
}): ReleaseSetV1 {
  const unsigned: Omit<ReleaseSetV1, 'release_set_root' | 'attestations'> = {
    contract: 'os-camp-release-set@1',
    course_id: input.courseId,
    version: input.version,
    public_package: { contract: 'os-camp-course@2', root_hash: input.publicPackageRoot },
    teacher_overlay: input.teacherOverlayRoot
      ? { contract: 'os-camp-teacher-overlay@1', root_hash: input.teacherOverlayRoot }
      : null,
    schema_versions: {
      course: 'os-camp-course@2',
      release_set: 'os-camp-release-set@1',
      teacher_overlay: 'os-camp-teacher-overlay@1',
      assertion: 'assertion-definition@1',
      evidence: 'evidence-envelope@1',
      source_composition: 'composition-manifest@1',
    },
    source_composition_root: input.sourceCompositionRoot,
    trust_policy: {
      trust_store_id: input.trustStoreId,
      required_roles: ['release_set'],
      worker_requires_verified_release_set: true,
      private_material_never_mounted_to_student: true,
    },
  };
  return { ...unsigned, release_set_root: computeReleaseSetRoot(unsigned), attestations: [] };
}

export function signReleaseSet(
  releaseSet: ReleaseSetV1,
  privateKeyPem: string,
  actor: string,
  signedAt = new Date().toISOString(),
): ReleaseSetV1 {
  if (!actor.trim()) throw new Error('Release Set 签名 actor 不能为空。');
  const { release_set_root: _root, attestations: _attestations, ...unsigned } = releaseSet;
  const expectedRoot = computeReleaseSetRoot(unsigned);
  if (expectedRoot !== releaseSet.release_set_root) throw new Error('Release Set 内容已变化，root hash 无效。');
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Release Set 私钥必须是 Ed25519 PKCS#8。');
  const publicKey = createPublicKey(privateKey);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const attestation: ReleaseSetAttestationV1 = {
    spec_version: 'release-set-attestation@1',
    actor: actor.trim(),
    role: 'release_set',
    key_fingerprint: fingerprint(publicKey),
    public_key: publicPem,
    release_set_root: releaseSet.release_set_root,
    signature: sign(
      null,
      releaseSetPayload(releaseSet.release_set_root, releaseSet.course_id, releaseSet.version),
      privateKey,
    ).toString('base64'),
    signed_at: signedAt,
  };
  const existing = releaseSet.attestations.filter((item) => (
    item.actor !== attestation.actor || item.key_fingerprint !== attestation.key_fingerprint
  ));
  return {
    ...releaseSet,
    attestations: [...existing, attestation].sort((a, b) => (
      a.actor.localeCompare(b.actor) || a.key_fingerprint.localeCompare(b.key_fingerprint)
    )),
  };
}

export function verifyReleaseSetAttestation(attestation: ReleaseSetAttestationV1, releaseSet: ReleaseSetV1): boolean {
  try {
    if (attestation.spec_version !== 'release-set-attestation@1'
      || attestation.role !== 'release_set'
      || attestation.release_set_root !== releaseSet.release_set_root
      || fingerprint(attestation.public_key) !== attestation.key_fingerprint) return false;
    return verify(
      null,
      releaseSetPayload(releaseSet.release_set_root, releaseSet.course_id, releaseSet.version),
      createPublicKey(attestation.public_key),
      Buffer.from(attestation.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

function trustedReleaseKey(attestation: ReleaseSetAttestationV1, keys: CourseTrustKey[]): boolean {
  return keys.some((key) => {
    if (key.revoked || key.actor !== attestation.actor) return false;
    try {
      const expected = fingerprint(key.public_key);
      return expected === attestation.key_fingerprint
        && (!key.key_fingerprint || key.key_fingerprint === expected);
    } catch {
      return false;
    }
  });
}

export function validateReleaseSet(
  releaseSet: ReleaseSetV1,
  input: {
    publicPackageRoot: string;
    teacherOverlayRoot: string | null;
    sourceCompositionRoot: string;
    trustKeys: CourseTrustKey[];
    requireSignature?: boolean;
  },
): ContractIssue[] {
  const findings: ContractIssue[] = [];
  const { release_set_root: _root, attestations: _attestations, ...unsigned } = releaseSet;
  const expectedRoot = computeReleaseSetRoot(unsigned);
  if (releaseSet.contract !== 'os-camp-release-set@1' || expectedRoot !== releaseSet.release_set_root) {
    findings.push(releaseIssue(releaseSet.course_id, 'Release Set contract 或 root hash 无效。'));
  }
  if (releaseSet.public_package.root_hash !== input.publicPackageRoot) {
    findings.push(releaseIssue(releaseSet.course_id, '公开课程包 root 与 Release Set 不一致。'));
  }
  if ((releaseSet.teacher_overlay?.root_hash ?? null) !== input.teacherOverlayRoot) {
    findings.push(releaseIssue(releaseSet.course_id, '教师 overlay root 与 Release Set 不一致。'));
  }
  if (releaseSet.source_composition_root !== input.sourceCompositionRoot) {
    findings.push(releaseIssue(releaseSet.course_id, 'source composition root 与 Release Set 不一致。'));
  }
  if (!releaseSet.trust_policy.worker_requires_verified_release_set
    || !releaseSet.trust_policy.private_material_never_mounted_to_student) {
    findings.push(releaseIssue(releaseSet.course_id, 'Release Set 不能降低 Worker 验证或私有材料隔离策略。'));
  }
  const signatureRequired = input.requireSignature ?? true;
  if (signatureRequired) {
    const trusted = releaseSet.attestations.some((attestation) => (
      verifyReleaseSetAttestation(attestation, releaseSet)
      && trustedReleaseKey(attestation, input.trustKeys)
    ));
    if (!trusted) findings.push(releaseIssue(releaseSet.course_id, 'Release Set 缺少有效且受信任的教师签名。'));
  }
  return findings;
}

export function compareReleaseSetVersions(previous: ReleaseSetV1, next: ReleaseSetV1): ContractIssue[] {
  if (previous.course_id !== next.course_id || previous.version !== next.version) return [];
  if (previous.public_package.root_hash !== next.public_package.root_hash
    || previous.teacher_overlay?.root_hash !== next.teacher_overlay?.root_hash
    || previous.source_composition_root !== next.source_composition_root) {
    return [releaseIssue(next.course_id, '同一课程版本不能替换 public、overlay 或 source composition root；请创建新版本。')];
  }
  return [];
}

export function releaseRequiresOverlay(
  practices: PracticeDefinitionV2[],
  assertions: AssertionDefinitionV1[],
): boolean {
  return practices.some((item) => item.governance.requires_teacher_overlay || item.hidden_material_ids.length > 0)
    || assertions.some((item) => item.visibility === 'teacher_private');
}

export function validateOverlayRequirement(
  releaseSet: ReleaseSetV1,
  practices: PracticeDefinitionV2[],
  assertions: AssertionDefinitionV1[],
): ContractIssue[] {
  return releaseRequiresOverlay(practices, assertions) && !releaseSet.teacher_overlay
    ? [releaseIssue(releaseSet.course_id, '课程引用私有 assertion/harness，但 Release Set 未绑定教师 overlay。')]
    : [];
}

export async function computeTeacherOverlayIndex(directory: string): Promise<TeacherOverlayIndexV1> {
  const root = path.resolve(directory);
  const paths = (await listPackageFiles(root)).filter((relative) => relative !== OVERLAY_INDEX_FILE);
  const files: TeacherOverlayIndexV1['files'] = [];
  for (const relative of paths) {
    if (!safeCoursePath(relative)) throw new Error(`教师 overlay 含不安全路径：${relative}`);
    const value = await readFile(path.join(root, relative));
    files.push({ path: relative, sha256: sha256(value), bytes: value.byteLength });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    contract: 'os-camp-teacher-overlay-index@1',
    algorithm: 'sha256',
    files,
    root_hash: sha256(`os-camp-teacher-overlay@1\0${canonicalJson(files)}`),
  };
}

export async function loadTeacherOverlayManifest(directory: string): Promise<TeacherOverlayManifestV1> {
  const file = path.join(path.resolve(directory), 'manifest.yaml');
  const parsed = YAML.parse(await readFile(file, 'utf8')) as TeacherOverlayManifestV1;
  if (parsed.contract !== 'os-camp-teacher-overlay@1') throw new Error('教师 overlay manifest contract 无效。');
  return parsed;
}

export function validateTeacherOverlayManifest(
  manifest: TeacherOverlayManifestV1,
  input: { courseId: string; version: string; publicPackageRoot: string; sourceCompositionRoot: string },
): ContractIssue[] {
  const findings: ContractIssue[] = [];
  if (manifest.course_id !== input.courseId || manifest.version !== input.version) {
    findings.push(releaseIssue(manifest.course_id, '教师 overlay 的课程身份与公开包不一致。'));
  }
  if (manifest.public_package_root !== input.publicPackageRoot) {
    findings.push(releaseIssue(manifest.course_id, '教师 overlay 未绑定当前公开包 root。'));
  }
  if (manifest.source_composition_root !== input.sourceCompositionRoot) {
    findings.push(releaseIssue(manifest.course_id, '教师 overlay 未绑定当前 source composition root。'));
  }
  return findings;
}
