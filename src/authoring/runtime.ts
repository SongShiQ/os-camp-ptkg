import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, opendir, readFile, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^[^@\s]+@sha256:[0-9a-f]{64}$/;

export interface RuntimeCacheIdentity {
  project_ref: { repo: string; commit: string };
  tree: string;
  image: { reference: string; id: string; repo_digests: string[] };
  prepare_command_hash: string;
}

export interface RuntimeFileEntry {
  path: string;
  kind: 'file' | 'symlink';
  size: number;
  sha256: string;
  target?: string;
}

export interface RuntimeCacheManifest extends RuntimeCacheIdentity {
  spec_version: 'ptkg-runtime@1';
  file_count: number;
  total_bytes: number;
  files_hash: string;
  root_hash: string;
  prepared_at: string;
}

export interface VerifiedRuntimeCache {
  root: string;
  assets: string;
  manifest: RuntimeCacheManifest;
  files: RuntimeFileEntry[];
}

export interface RuntimeCacheExpectation {
  project_ref: { repo: string; commit: string };
  tree: string;
  image_reference: string;
  image_id: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function comparePath(left: RuntimeFileEntry, right: RuntimeFileEntry): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function safeRelative(root: string, file: string): string {
  const relative = path.relative(root, file);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`runtime cache 路径越界：${file}`);
  }
  return relative.split(path.sep).join('/');
}

interface PendingRuntimeFile {
  path: string;
  full: string;
  kind: 'file' | 'symlink';
  size: number;
  target?: string;
}

async function collectPendingFiles(root: string, current = root): Promise<PendingRuntimeFile[]> {
  const entries: PendingRuntimeFile[] = [];
  const directory = await opendir(current);
  for await (const dirent of directory) {
    const full = path.join(current, dirent.name);
    const info = await lstat(full);
    if (info.isDirectory()) {
      entries.push(...await collectPendingFiles(root, full));
      continue;
    }
    const relative = safeRelative(root, full);
    if (info.isSymbolicLink()) {
      const target = await readlink(full);
      const resolved = path.resolve(path.dirname(full), target);
      safeRelative(root, resolved);
      entries.push({
        path: relative,
        full,
        kind: 'symlink',
        size: 0,
        target,
      });
      continue;
    }
    if (!info.isFile()) throw new Error(`runtime cache 只允许普通文件、目录和内部符号链接：${relative}`);
    entries.push({ path: relative, full, kind: 'file', size: info.size });
  }
  return entries;
}

async function collectEntries(root: string): Promise<RuntimeFileEntry[]> {
  const pending = await collectPendingFiles(root);
  const entries = new Array<RuntimeFileEntry>(pending.length);
  const workerCount = Math.min(8, pending.length);
  let next = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < pending.length) {
      const index = next++;
      const entry = pending[index];
      if (!entry) throw new Error(`runtime cache 并发索引越界：${index}`);
      entries[index] = entry.kind === 'symlink'
        ? { path: entry.path, kind: entry.kind, size: 0, sha256: sha256(`symlink\0${entry.target}`), target: entry.target }
        : { path: entry.path, kind: entry.kind, size: entry.size, sha256: await hashFile(entry.full) };
    }
  }));
  return entries.sort(comparePath);
}

function filesText(entries: RuntimeFileEntry[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function rootHash(identity: RuntimeCacheIdentity, filesHash: string): string {
  const payload = {
    project_ref: identity.project_ref,
    tree: identity.tree,
    image: {
      reference: identity.image.reference,
      id: identity.image.id,
      repo_digests: [...identity.image.repo_digests].sort(),
    },
    prepare_command_hash: identity.prepare_command_hash,
    files_hash: filesHash,
  };
  return sha256(`ptkg-runtime@1\0${JSON.stringify(payload)}`);
}

function assertIdentity(identity: RuntimeCacheIdentity): void {
  if (!identity.project_ref.repo || !SHA40.test(identity.project_ref.commit)) {
    throw new Error('runtime cache project_ref 必须包含仓库和 40 位 commit。');
  }
  if (!SHA40.test(identity.tree)) throw new Error('runtime cache tree 必须是 40 位 Git tree。');
  if (!IMAGE_DIGEST.test(identity.image.reference) || !identity.image.id) {
    throw new Error('runtime cache image 必须包含固定 digest 引用和 image ID。');
  }
  if (!identity.image.repo_digests.includes(identity.image.reference)) {
    throw new Error('runtime cache image RepoDigests 未确认请求的固定镜像。');
  }
  if (!SHA256.test(identity.prepare_command_hash)) {
    throw new Error('runtime cache prepare_command_hash 必须是 SHA-256。');
  }
}

export function hashRuntimePrepareCommand(command: string): string {
  return sha256(command);
}

export async function writeRuntimeCacheManifest(
  cacheDir: string,
  identity: RuntimeCacheIdentity,
): Promise<VerifiedRuntimeCache> {
  assertIdentity(identity);
  const root = path.resolve(cacheDir);
  const assets = path.join(root, 'assets');
  await mkdir(assets, { recursive: true });
  const entries = await collectEntries(assets);
  if (entries.length === 0) throw new Error('runtime cache assets 为空，不能生成可信 manifest。');
  const serialized = filesText(entries);
  const filesHash = sha256(serialized);
  const manifest: RuntimeCacheManifest = {
    spec_version: 'ptkg-runtime@1',
    project_ref: identity.project_ref,
    tree: identity.tree,
    image: {
      reference: identity.image.reference,
      id: identity.image.id,
      repo_digests: [...identity.image.repo_digests].sort(),
    },
    prepare_command_hash: identity.prepare_command_hash,
    file_count: entries.length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    files_hash: filesHash,
    root_hash: rootHash(identity, filesHash),
    prepared_at: new Date().toISOString(),
  };
  await writeFile(path.join(root, 'files.jsonl'), serialized, 'utf8');
  await writeFile(path.join(root, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { root, assets, manifest, files: entries };
}

function sameEntries(left: RuntimeFileEntry[], right: RuntimeFileEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function verifyRuntimeCache(
  cacheDir: string,
  expected?: RuntimeCacheExpectation,
): Promise<VerifiedRuntimeCache> {
  const root = path.resolve(cacheDir);
  const assets = path.join(root, 'assets');
  const manifest = JSON.parse(await readFile(path.join(root, 'runtime-manifest.json'), 'utf8')) as RuntimeCacheManifest;
  assertIdentity(manifest);
  if (manifest.spec_version !== 'ptkg-runtime@1') throw new Error('不支持的 runtime cache spec_version。');
  const recorded = (await readFile(path.join(root, 'files.jsonl'), 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeFileEntry)
    .sort(comparePath);
  const actual = await collectEntries(assets);
  if (!sameEntries(recorded, actual)) throw new Error('runtime cache 文件与 files.jsonl 不一致。');
  const serialized = filesText(recorded);
  const filesHash = sha256(serialized);
  const identity: RuntimeCacheIdentity = {
    project_ref: manifest.project_ref,
    tree: manifest.tree,
    image: manifest.image,
    prepare_command_hash: manifest.prepare_command_hash,
  };
  if (
    manifest.file_count !== recorded.length
    || manifest.total_bytes !== recorded.reduce((sum, entry) => sum + entry.size, 0)
    || manifest.files_hash !== filesHash
    || manifest.root_hash !== rootHash(identity, filesHash)
  ) {
    throw new Error('runtime cache manifest hash 或统计不一致。');
  }
  if (expected && (
    manifest.project_ref.repo !== expected.project_ref.repo
    || manifest.project_ref.commit !== expected.project_ref.commit
    || manifest.tree !== expected.tree
    || manifest.image.reference !== expected.image_reference
    || manifest.image.id !== expected.image_id
  )) {
    throw new Error('runtime cache 与固定源码或固定镜像身份不匹配。');
  }
  return { root, assets, manifest, files: recorded };
}
