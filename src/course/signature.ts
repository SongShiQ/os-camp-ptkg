import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

import type { CourseAttestation, CourseTrustKey, CourseTrustStore } from './types.ts';
import { canonicalJson, sha256 } from './io.ts';

export function courseSignaturePayload(rootHash: string, courseId: string, version: string): Buffer {
  return Buffer.from(`course-attestation@1\0${canonicalJson({
    course_id: courseId,
    root_hash: rootHash,
    version,
  })}`, 'utf8');
}

export function publicKeyFingerprint(publicKey: string | KeyObject): string {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  const der = key.export({ type: 'spki', format: 'der' });
  return `sha256:${sha256(der)}`;
}

export function createCourseAttestation(input: {
  privateKeyPem: string;
  actor: string;
  rootHash: string;
  courseId: string;
  version: string;
  signedAt?: string;
}): CourseAttestation {
  const privateKey = createPrivateKey(input.privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('课程签名私钥必须是 Ed25519 PKCS#8。');
  const publicKey = createPublicKey(privateKey);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const signature = sign(null, courseSignaturePayload(input.rootHash, input.courseId, input.version), privateKey);
  return {
    spec_version: 'course-attestation@1',
    actor: input.actor,
    role: 'course_release',
    key_fingerprint: publicKeyFingerprint(publicKey),
    public_key: publicPem,
    root_hash: input.rootHash,
    signature: signature.toString('base64'),
    signed_at: input.signedAt ?? new Date().toISOString(),
  };
}

export function verifyCourseAttestation(
  attestation: CourseAttestation,
  courseId: string,
  version: string,
): boolean {
  try {
    if (attestation.spec_version !== 'course-attestation@1' || attestation.role !== 'course_release') return false;
    if (publicKeyFingerprint(attestation.public_key) !== attestation.key_fingerprint) return false;
    return verify(
      null,
      courseSignaturePayload(attestation.root_hash, courseId, version),
      createPublicKey(attestation.public_key),
      Buffer.from(attestation.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

export async function loadCourseTrustStore(file?: string): Promise<CourseTrustStore | null> {
  if (!file) return null;
  const text = await readFile(file, 'utf8');
  const parsed = file.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
  if (!parsed || parsed.spec_version !== 'ptkg-trust-store@1' || !Array.isArray(parsed.keys)) {
    throw new Error('信任库必须使用 ptkg-trust-store@1，并包含 keys 数组。');
  }
  return parsed as CourseTrustStore;
}

export function trustedCourseKey(attestation: CourseAttestation, keys: CourseTrustKey[]): boolean {
  return keys.some((key) => {
    if (key.revoked || key.actor !== attestation.actor) return false;
    try {
      const fingerprint = publicKeyFingerprint(key.public_key);
      return fingerprint === attestation.key_fingerprint
        && (!key.key_fingerprint || key.key_fingerprint === fingerprint);
    } catch {
      return false;
    }
  });
}
