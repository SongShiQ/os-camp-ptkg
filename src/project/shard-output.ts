import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, sha256 } from '../course/io.ts';
import { compareCanonicalString } from '../io/stable.ts';

export interface AgentShardOutputFile {
  path: string;
  byte_length: number;
  sha256: string;
}

export interface AgentShardSeal {
  spec_version: 'ptkg-agent-shard-seal@1';
  shard_id: string;
  manifest_hash: string;
  files: AgentShardOutputFile[];
  output_hash: string;
}

export interface ShardOutputSnapshot {
  files: AgentShardOutputFile[];
  output_hash: string;
}

function outputHash(files: AgentShardOutputFile[]): string {
  return sha256(canonicalJson({ spec_version: 'ptkg-agent-shard-output@1', files }));
}

export async function snapshotShardOutput(root: string): Promise<ShardOutputSnapshot> {
  const base = path.resolve(root);
  const files: AgentShardOutputFile[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCanonicalString(left.name, right.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`shard output 不允许符号链接：${full}`);
      if (info.isDirectory()) {
        await visit(full);
      } else if (info.isFile()) {
        const relative = path.relative(base, full).split(path.sep).join('/');
        const bytes = await readFile(full);
        files.push({ path: relative, byte_length: bytes.byteLength, sha256: sha256(bytes) });
      } else {
        throw new Error(`shard output 不允许特殊文件：${full}`);
      }
    }
  }
  await visit(base);
  files.sort((left, right) => compareCanonicalString(left.path, right.path));
  if (files.length === 0) throw new Error('shard output 为空。');
  return { files, output_hash: outputHash(files) };
}

export async function readShardSeal(file: string): Promise<AgentShardSeal> {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('seal.json 必须是普通文件。');
  const value = JSON.parse(await readFile(file, 'utf8')) as Partial<AgentShardSeal>;
  if (
    value.spec_version !== 'ptkg-agent-shard-seal@1'
    || typeof value.shard_id !== 'string'
    || typeof value.manifest_hash !== 'string'
    || !Array.isArray(value.files)
    || typeof value.output_hash !== 'string'
  ) throw new Error('seal.json 不符合 ptkg-agent-shard-seal@1。');
  const files = value.files as AgentShardOutputFile[];
  if (files.some((entry) => (
    !entry || typeof entry.path !== 'string' || !entry.path || path.posix.isAbsolute(entry.path)
    || entry.path.includes('..') || !Number.isInteger(entry.byte_length) || entry.byte_length < 0
    || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)
  ))) throw new Error('seal.json files 字段无效。');
  const sorted = [...files].sort((left, right) => compareCanonicalString(left.path, right.path));
  if (canonicalJson(files) !== canonicalJson(sorted) || new Set(files.map((entry) => entry.path)).size !== files.length) {
    throw new Error('seal.json files 必须按稳定路径排序且不得重复。');
  }
  if (value.output_hash !== outputHash(files)) throw new Error('seal.json output_hash 不匹配 files。');
  return value as AgentShardSeal;
}

export async function verifyShardSeal(
  outputRoot: string,
  sealFile: string,
  expectedShardId: string,
  expectedManifestHash: string,
): Promise<{ valid: true; seal: AgentShardSeal; snapshot: ShardOutputSnapshot } | { valid: false; reason: string }> {
  try {
    const seal = await readShardSeal(sealFile);
    if (seal.shard_id !== expectedShardId || seal.manifest_hash !== expectedManifestHash) {
      return { valid: false, reason: 'seal 与 shard/manifest hash 不一致。' };
    }
    const snapshot = await snapshotShardOutput(outputRoot);
    if (canonicalJson(snapshot.files) !== canonicalJson(seal.files) || snapshot.output_hash !== seal.output_hash) {
      return { valid: false, reason: 'seal 后 output 已发生变化。' };
    }
    return { valid: true, seal, snapshot };
  } catch (error) {
    return { valid: false, reason: (error as Error).message };
  }
}
