import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;

export interface WorkspaceLease {
  spec_version: 'ptkg-workspace-lease@1';
  token: string;
  owner: string;
  pid: number;
  acquired_at: string;
  expires_at: string;
}

export interface WorkspaceLeaseOptions {
  owner: string;
  ttlMs: number;
  now?: () => number;
  pid?: number;
}

export class WorkspaceLeaseBusyError extends Error {
  readonly lease: WorkspaceLease;

  constructor(file: string, lease: WorkspaceLease) {
    super(`workspace lease 正在使用：${file}（owner=${lease.owner}，expires=${lease.expires_at}）`);
    this.name = 'WorkspaceLeaseBusyError';
    this.lease = lease;
  }
}

export class WorkspaceLeaseStaleError extends Error {
  readonly lease: WorkspaceLease;

  constructor(file: string, lease: WorkspaceLease) {
    super(`workspace lease 已过期但拒绝自动接管：${file}（owner=${lease.owner}，token=${lease.token}）。请确认旧进程已停止后显式恢复。`);
    this.name = 'WorkspaceLeaseStaleError';
    this.lease = lease;
  }
}

export interface RecoverWorkspaceLeaseOptions {
  expectedToken: string;
  confirmOwnerStopped: boolean;
  now?: () => number;
}

async function rejectSymlinkComponents(target: string): Promise<void> {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error(`路径不允许符号链接：${current}`);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF'].includes(code ?? '')) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Write a complete sibling temporary file and atomically replace the target. */
export async function atomicWriteFile(
  file: string,
  data: string | Uint8Array,
  encoding: BufferEncoding = 'utf8',
): Promise<void> {
  const target = path.resolve(file);
  const directory = path.dirname(target);
  await rejectSymlinkComponents(directory);
  await mkdir(directory, { recursive: true });
  await rejectSymlinkComponents(directory);
  const temporary = path.join(directory, `.${path.basename(target)}.tmp-${process.pid}-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, 'wx', 0o600);
    const bytes = typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseLease(raw: string, file: string): WorkspaceLease {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`workspace lease 无法解析，拒绝自动回收 ${file}：${(error as Error).message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`workspace lease 格式无效，拒绝自动回收 ${file}。`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.spec_version !== 'ptkg-workspace-lease@1'
    || typeof record.token !== 'string'
    || typeof record.owner !== 'string'
    || typeof record.pid !== 'number'
    || typeof record.acquired_at !== 'string'
    || typeof record.expires_at !== 'string'
    || !Number.isFinite(Date.parse(record.expires_at))
  ) {
    throw new Error(`workspace lease 字段无效，拒绝自动回收 ${file}。`);
  }
  return record as unknown as WorkspaceLease;
}

async function rejectSymlink(file: string): Promise<void> {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info?.isSymbolicLink()) throw new Error(`workspace lease 不允许符号链接：${file}`);
  if (info && !info.isFile()) throw new Error(`workspace lease 必须是普通文件：${file}`);
}

async function createLease(file: string, lease: WorkspaceLease): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(file, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(lease)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(path.dirname(file));
    return true;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function acquireLease(file: string, options: WorkspaceLeaseOptions): Promise<WorkspaceLease> {
  const clock = options.now ?? Date.now;
  for (let attempt = 0; attempt < 8; attempt++) {
    const now = clock();
    const lease: WorkspaceLease = {
      spec_version: 'ptkg-workspace-lease@1',
      token: randomUUID(),
      owner: options.owner,
      pid: options.pid ?? process.pid,
      acquired_at: new Date(now).toISOString(),
      expires_at: new Date(now + options.ttlMs).toISOString(),
    };
    if (await createLease(file, lease)) return lease;

    await rejectSymlink(file);
    let first: string;
    try {
      first = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const existing = parseLease(first, file);
    if (Date.parse(existing.expires_at) > clock()) throw new WorkspaceLeaseBusyError(file, existing);
    throw new WorkspaceLeaseStaleError(file, existing);
  }
  throw new Error(`无法安全获得 workspace lease：${file}`);
}

/**
 * Remove one expired lease only after an operator has verified that the old
 * process stopped. Token matching prevents clearing a lease that was renewed
 * or replaced between inspection and recovery.
 */
export async function recoverWorkspaceLease(
  lockPath: string,
  options: RecoverWorkspaceLeaseOptions,
): Promise<void> {
  if (!options.confirmOwnerStopped) {
    throw new Error('恢复过期 workspace lease 前必须确认旧 owner 进程已经停止。');
  }
  if (!options.expectedToken.trim()) throw new Error('恢复 workspace lease 必须提供 expectedToken。');
  const file = path.resolve(lockPath);
  const clock = options.now ?? Date.now;
  await rejectSymlinkComponents(path.dirname(file));
  await rejectSymlink(file);
  const first = await readFile(file, 'utf8');
  const existing = parseLease(first, file);
  if (existing.token !== options.expectedToken) {
    throw new Error(`workspace lease token 已变化，拒绝恢复：expected=${options.expectedToken} actual=${existing.token}`);
  }
  if (Date.parse(existing.expires_at) > clock()) {
    throw new WorkspaceLeaseBusyError(file, existing);
  }
  const second = await readFile(file, 'utf8');
  if (second !== first) throw new Error('workspace lease 在恢复确认期间发生变化，拒绝删除。');
  const confirmed = parseLease(second, file);
  if (confirmed.token !== options.expectedToken || Date.parse(confirmed.expires_at) > clock()) {
    throw new Error('workspace lease 在恢复确认期间被更新，拒绝删除。');
  }
  await unlink(file);
  await syncDirectory(path.dirname(file));
}

async function releaseLease(file: string, owned: WorkspaceLease): Promise<void> {
  await rejectSymlink(file);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const current = parseLease(raw, file);
  if (current.token !== owned.token) return;
  try {
    await unlink(file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function withWorkspaceLease<T>(
  lockPath: string,
  options: WorkspaceLeaseOptions,
  operation: (lease: WorkspaceLease) => Promise<T> | T,
): Promise<T> {
  if (!options.owner.trim()) throw new Error('workspace lease owner 不能为空。');
  if (!Number.isFinite(options.ttlMs) || options.ttlMs < 1 || options.ttlMs > MAX_LEASE_TTL_MS) {
    throw new Error(`workspace lease ttlMs 必须在 1..${MAX_LEASE_TTL_MS} 之间。`);
  }
  const file = path.resolve(lockPath);
  await rejectSymlinkComponents(path.dirname(file));
  await mkdir(path.dirname(file), { recursive: true });
  await rejectSymlinkComponents(path.dirname(file));
  await rejectSymlink(file);
  const lease = await acquireLease(file, options);
  try {
    return await operation(lease);
  } finally {
    await releaseLease(file, lease);
  }
}
