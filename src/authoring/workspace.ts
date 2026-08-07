import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadAuthoringRun } from './loader.ts';
import type { AnchorVerification, AuthoringObject, ProjectRef } from './types.ts';

const execFileAsync = promisify(execFile);
const SHA40 = /^[0-9a-f]{40}$/;

interface CheckoutCandidate {
  repository: string;
  ref: string;
}

export interface WorkspaceVerificationResult {
  project_ref: ProjectRef;
  tree: string;
  cache_repo: string;
  fetched_from: CheckoutCandidate;
  parser_capabilities: {
    git_tree: true;
    rust_declaration: 'builtin';
    rust_analyzer: 'not_required';
  };
  anchors: AnchorVerification[];
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function defaultCacheDir(): string {
  return path.join(process.env.USERPROFILE ?? homedir(), '.cache', 'ptkg');
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

async function prepareBareRepo(cacheDir: string, repository: string): Promise<string> {
  const repoKey = hashText(repository).slice(0, 20);
  const repoDir = path.join(cacheDir, 'git', `${repoKey}.git`);
  await mkdir(repoDir, { recursive: true });
  try {
    await git(repoDir, ['rev-parse', '--is-bare-repository']);
  } catch {
    await git(repoDir, ['init', '--bare']);
  }
  return repoDir;
}

async function hasCommitObject(repoDir: string, commit: string): Promise<boolean> {
  try {
    return (await git(repoDir, ['cat-file', '-t', commit])) === 'commit';
  } catch {
    return false;
  }
}

/**
 * 取得固定 commit 的对象，而不是要求候选 ref 的 tip 正好等于它。
 *
 * 冻结基线（SCOPE §7）在上游分支继续前进后仍必须可验证，因此判据是
 * “该 commit 对象在本地对象库中可得”，不是“ref tip == commit”。
 * 内容完整性由调用方的 expected_tree 比对保证。
 */
async function fetchFixedCommit(
  cacheDir: string,
  expectedCommit: string,
  candidates: CheckoutCandidate[],
): Promise<{ repoDir: string; candidate: CheckoutCandidate }> {
  const errors: string[] = [];
  for (const candidate of candidates) {
    const repoDir = await prepareBareRepo(cacheDir, candidate.repository);
    // 已缓存的冻结 commit 不需要再联网，也不受上游 ref 移动影响。
    if (await hasCommitObject(repoDir, expectedCommit)) {
      return { repoDir, candidate };
    }
    try {
      await git(repoDir, ['fetch', '--force', '--no-tags', candidate.repository, candidate.ref]);
    } catch (error) {
      errors.push(`${candidate.repository} ${candidate.ref}: ${(error as Error).message}`);
      continue;
    }
    if (await hasCommitObject(repoDir, expectedCommit)) {
      return { repoDir, candidate };
    }
    let tip = '(unknown)';
    try {
      tip = await git(repoDir, ['rev-parse', 'FETCH_HEAD^{commit}']);
    } catch {
      // tip 解析失败不改变结论：该候选取不到固定 commit。
    }
    errors.push(`${candidate.repository} ${candidate.ref} 的 tip ${tip} 不可达该 commit`);
  }
  throw new Error(`无法从候选来源取得固定 commit ${expectedCommit}：${errors.join('；')}`);
}

function safeRepoPath(raw: string): string | null {
  if (raw.includes('\\') || path.posix.isAbsolute(raw)) return null;
  const normalized = path.posix.normalize(raw.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.') return null;
  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function declarationMatches(source: string, symbol: string, extension: string): number[] {
  const simple = symbol.split('::').at(-1) ?? symbol;
  const escaped = escapeRegExp(simple);
  const patterns = extension === '.rs'
    ? [
        new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:const\\s+)?fn\\s+${escaped}\\b`),
        new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|trait|type|const|static|mod)\\s+${escaped}\\b`),
        new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?macro_rules!\\s+${escaped}\\b`),
      ]
    : [
        new RegExp(`^\\s*(?:[A-Za-z_][A-Za-z0-9_]*\\s+|[*]\\s*)+${escaped}\\s*\\(`),
        new RegExp(`^\\s*(?:struct|enum|typedef)\\b.*\\b${escaped}\\b`),
      ];
  const matches: number[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (patterns.some((pattern) => pattern.test(line))) matches.push(index + 1);
  }
  return matches;
}

function collectAnchors(objects: AuthoringObject[]): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const object of objects) {
    if (!Array.isArray(object.anchors)) continue;
    for (const anchor of object.anchors) {
      if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) continue;
      const record = anchor as Record<string, unknown>;
      if (typeof record.id === 'string' && !byId.has(record.id)) byId.set(record.id, record);
    }
  }
  return [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function verifyAnchor(
  repoDir: string,
  projectRef: ProjectRef,
  anchor: Record<string, unknown>,
): Promise<AnchorVerification> {
  const anchorId = String(anchor.id ?? '(missing-anchor-id)');
  const rawPath = typeof anchor.path === 'string' ? anchor.path : '';
  const repoPath = safeRepoPath(rawPath);
  const symbol = typeof anchor.symbol === 'string' && anchor.symbol.trim() !== '' ? anchor.symbol : null;
  const base = { anchor_id: anchorId, project_ref: projectRef, path: rawPath, symbol };
  if (!repoPath) {
    return { ...base, status: 'unresolved', parser: 'git-path', reason: 'path 为空、为绝对路径或包含目录穿越。' };
  }

  let entry: string;
  try {
    entry = await git(repoDir, ['ls-tree', projectRef.commit, '--', repoPath]);
  } catch (error) {
    return { ...base, status: 'unresolved', parser: 'git-path', reason: `Git tree 查询失败：${(error as Error).message}` };
  }
  const match = entry.match(/^[0-7]+\s+blob\s+([0-9a-f]{40})\t/);
  if (!match?.[1]) {
    return { ...base, status: 'unresolved', parser: 'git-path', reason: '固定 commit 中不存在该文件 blob。' };
  }
  const blobOid = match[1];
  if (!symbol) {
    return { ...base, status: 'verified', parser: 'git-path', blob_oid: blobOid };
  }
  const source = await git(repoDir, ['show', `${projectRef.commit}:${repoPath}`]);
  const lines = declarationMatches(source, symbol, path.posix.extname(repoPath).toLowerCase());
  if (lines.length !== 1) {
    return {
      ...base,
      status: 'unresolved',
      parser: 'rust-declaration-v1',
      blob_oid: blobOid,
      reason: lines.length === 0 ? '未找到 symbol 声明；调用引用不算声明。' : `symbol 声明有 ${lines.length} 处，无法唯一定位。`,
    };
  }
  const line = lines[0] as number;
  const snippet = source.split(/\r?\n/)[line - 1] ?? '';
  return {
    ...base,
    status: 'verified',
    parser: 'rust-declaration-v1',
    blob_oid: blobOid,
    symbol_start_line: line,
    symbol_end_line: line,
    snippet_hash: hashText(snippet.trim()),
  };
}

export async function verifyAuthoringWorkspace(
  runDir: string,
  cacheDir = defaultCacheDir(),
): Promise<WorkspaceVerificationResult> {
  const loaded = await loadAuthoringRun(runDir);
  if (!loaded.run) throw new Error(`无法载入作者运行：${loaded.findings.map((item) => item.message).join('；')}`);
  const run = loaded.run;
  const projectRef = run.sourceContract.project_ref;
  if (!SHA40.test(projectRef.commit)) throw new Error('source-contract project_ref.commit 必须是 40 位 SHA。');
  const checkout = run.sourceContract.checkout as Record<string, unknown> | undefined;
  const expectedTree = typeof checkout?.expected_tree === 'string' ? checkout.expected_tree : '';
  const candidates = Array.isArray(checkout?.candidates)
    ? checkout.candidates.filter((item): item is CheckoutCandidate => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const candidate = item as Record<string, unknown>;
        return typeof candidate.repository === 'string' && typeof candidate.ref === 'string';
      })
    : [];
  if (!SHA40.test(expectedTree) || candidates.length === 0) throw new Error('source-contract.checkout 不完整。');

  const fetched = await fetchFixedCommit(cacheDir, projectRef.commit, candidates);
  const actualTree = await git(fetched.repoDir, ['show', '-s', '--format=%T', projectRef.commit]);
  if (actualTree !== expectedTree) {
    throw new Error(`固定 commit 的 tree 不匹配：期望 ${expectedTree}，实际 ${actualTree}。`);
  }
  const anchors = collectAnchors([...run.codeFacts, ...run.behaviorChains]);
  const verifications: AnchorVerification[] = [];
  for (const anchor of anchors) verifications.push(await verifyAnchor(fetched.repoDir, projectRef, anchor));

  const result: WorkspaceVerificationResult = {
    project_ref: projectRef,
    tree: actualTree,
    cache_repo: fetched.repoDir,
    fetched_from: fetched.candidate,
    parser_capabilities: { git_tree: true, rust_declaration: 'builtin', rust_analyzer: 'not_required' },
    anchors: verifications,
  };
  const factsDir = path.join(runDir, '02-facts');
  await mkdir(factsDir, { recursive: true });
  await writeFile(
    path.join(factsDir, 'anchor-verification.jsonl'),
    `${verifications.map((item) => JSON.stringify(item)).join('\n')}\n`,
    'utf8',
  );
  await writeFile(path.join(factsDir, 'workspace-verification.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}
