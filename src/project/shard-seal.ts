import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from '../io/atomic.ts';
import { canonicalJson, sha256 } from '../course/io.ts';
import { loadActiveAuthoringShard } from './task-split.ts';
import { snapshotShardOutput, type AgentShardSeal } from './shard-output.ts';

export async function sealAuthoringShard(workspace: string, shardId: string): Promise<AgentShardSeal> {
  const shard = await loadActiveAuthoringShard(workspace, shardId);
  const snapshot = await snapshotShardOutput(shard.output_root);
  const manifestHash = sha256(canonicalJson(shard.manifest));
  const seal: AgentShardSeal = {
    spec_version: 'ptkg-agent-shard-seal@1',
    shard_id: shardId,
    manifest_hash: manifestHash,
    files: snapshot.files,
    output_hash: snapshot.output_hash,
  };
  const sealFile = path.join(shard.shard_root, 'seal.json');
  const existing = await lstat(sealFile).catch(() => null);
  if (existing?.isSymbolicLink()) throw new Error('seal.json 不允许符号链接。');
  await atomicWriteFile(sealFile, `${canonicalJson(seal)}\n`);
  return seal;
}
