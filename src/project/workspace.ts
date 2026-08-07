import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';

import { computeContentHash } from '../authoring/hash.ts';
import type { AuthoringObject } from '../authoring/types.ts';
import { verifyAuthoringWorkspace } from '../authoring/workspace.ts';
import { runSourceAnalyzers } from './analyzers.ts';
import { getProjectStatus } from './status.ts';
import type {
  AnalyzerContext,
  GitSnapshot,
  ProjectDocument,
  ProjectInitOptions,
  ProjectInitResult,
  ProjectInput,
} from './types.ts';

const execFileAsync = promisify(execFile);
const SHA40 = /^[0-9a-f]{40}$/;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'project';
}

export function defaultProjectCacheDir(): string {
  return path.join(process.env.USERPROFILE ?? homedir(), '.cache', 'ptkg');
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    ...(cwd ? { cwd } : {}),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

async function hasCommit(gitDir: string, commit: string): Promise<boolean> {
  try {
    return await git([`--git-dir=${gitDir}`, 'cat-file', '-t', commit]) === 'commit';
  } catch {
    return false;
  }
}

async function ensureCheckout(gitDir: string, cacheDir: string, repoKey: string, commit: string): Promise<string> {
  const checkout = path.join(cacheDir, 'checkouts', repoKey, commit);
  try {
    const existing = await git(['-C', checkout, 'rev-parse', 'HEAD^{commit}']);
    if (existing !== commit) throw new Error(`缓存 checkout 指向 ${existing}，期望 ${commit}。`);
    const dirty = await git(['-C', checkout, 'status', '--porcelain']);
    if (dirty !== '') throw new Error(`缓存 checkout 已被修改，拒绝复用：${checkout}`);
  } catch (error) {
    if ((error as Error).message.startsWith('缓存 checkout')) throw error;
    await mkdir(path.dirname(checkout), { recursive: true });
    await git([`--git-dir=${gitDir}`, 'worktree', 'add', '--detach', checkout, commit]);
  }
  return checkout;
}

function isRemote(locator: string): boolean {
  return /^https?:\/\//i.test(locator) || /^git@/i.test(locator) || /^ssh:\/\//i.test(locator);
}

async function ensureRemoteSnapshot(locator: string, requestedRef: string | undefined, cacheDir: string): Promise<GitSnapshot> {
  const repoKey = sha256(locator).slice(0, 20);
  const repoDir = path.join(cacheDir, 'git', `${repoKey}.git`);
  try {
    await git([`--git-dir=${repoDir}`, 'rev-parse', '--is-bare-repository']);
  } catch {
    await mkdir(path.dirname(repoDir), { recursive: true });
    await git(['clone', '--mirror', locator, repoDir]);
  }
  let commit = '';
  if (requestedRef && SHA40.test(requestedRef)) {
    try {
      commit = await git([`--git-dir=${repoDir}`, 'rev-parse', `${requestedRef}^{commit}`]);
    } catch {
      await git([`--git-dir=${repoDir}`, 'fetch', '--force', '--no-tags', locator, requestedRef]);
      commit = await git([`--git-dir=${repoDir}`, 'rev-parse', 'FETCH_HEAD^{commit}']);
    }
  } else {
    await git([`--git-dir=${repoDir}`, 'fetch', '--force', '--no-tags', locator, requestedRef ?? 'HEAD']);
    commit = await git([`--git-dir=${repoDir}`, 'rev-parse', 'FETCH_HEAD^{commit}']);
  }
  const tree = await git([`--git-dir=${repoDir}`, 'show', '-s', '--format=%T', commit]);
  const checkout = await ensureCheckout(repoDir, cacheDir, repoKey, commit);
  return {
    projectRef: { repo: locator, commit },
    tree,
    repositoryKind: 'remote',
    repositoryLocator: locator,
    requestedRef: requestedRef ?? null,
    gitDir: repoDir,
    sourceRoot: checkout,
  };
}

async function ensureLocalSnapshot(locator: string, requestedRef: string | undefined, cacheDir: string): Promise<GitSnapshot> {
  const root = path.resolve(locator);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`本地仓库不存在或不是目录：${root}`);
  const inside = await git(['-C', root, 'rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') throw new Error(`路径不是 Git 工作树：${root}`);
  const commit = await git(['-C', root, 'rev-parse', `${requestedRef ?? 'HEAD'}^{commit}`]);
  const tree = await git(['-C', root, 'show', '-s', '--format=%T', commit]);
  const repoKey = sha256(root).slice(0, 20);
  const gitDir = path.join(cacheDir, 'git', `${repoKey}.git`);
  try {
    await git([`--git-dir=${gitDir}`, 'rev-parse', '--is-bare-repository']);
  } catch {
    await mkdir(path.dirname(gitDir), { recursive: true });
    await git(['init', '--bare', gitDir]);
  }
  if (!(await hasCommit(gitDir, commit))) {
    await git([`--git-dir=${gitDir}`, 'fetch', '--force', '--no-tags', root, commit]);
  }
  if (!(await hasCommit(gitDir, commit))) throw new Error(`无法把本地固定 commit 写入缓存：${commit}`);
  const sourceRoot = await ensureCheckout(gitDir, cacheDir, repoKey, commit);
  return {
    projectRef: { repo: root, commit },
    tree,
    repositoryKind: 'local',
    repositoryLocator: root,
    requestedRef: requestedRef ?? null,
    gitDir,
    sourceRoot,
  };
}

export async function resolveGitSnapshot(
  locator: string,
  requestedRef?: string,
  cacheDir = defaultProjectCacheDir(),
): Promise<GitSnapshot> {
  return isRemote(locator)
    ? ensureRemoteSnapshot(locator, requestedRef, cacheDir)
    : ensureLocalSnapshot(locator, requestedRef, cacheDir);
}

function analyzerContext(snapshot: GitSnapshot, runId: string): AnalyzerContext {
  let files: string[] | null = null;
  return {
    runId,
    projectRef: snapshot.projectRef,
    commit: snapshot.projectRef.commit,
    async listFiles() {
      if (files) return files;
      const text = await git([`--git-dir=${snapshot.gitDir}`, 'ls-tree', '-r', '--name-only', snapshot.projectRef.commit]);
      files = text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).sort();
      return files;
    },
    async readFile(file: string) {
      if (file.includes('\\') || path.posix.isAbsolute(file) || path.posix.normalize(file).startsWith('../')) {
        throw new Error(`不安全的 Git path：${file}`);
      }
      return git([`--git-dir=${snapshot.gitDir}`, 'show', `${snapshot.projectRef.commit}:${file}`]);
    },
  };
}

async function readDocument(locator: string, index: number, inputDir: string): Promise<ProjectDocument> {
  const id = `doc.${String(index + 1).padStart(3, '0')}.${sha256(locator).slice(0, 12)}`;
  if (/^https?:\/\//i.test(locator)) {
    const response = await fetch(locator, { redirect: 'follow' });
    if (!response.ok) throw new Error(`文档下载失败 ${response.status}：${locator}`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_DOCUMENT_BYTES) throw new Error(`文档超过 2 MiB：${locator}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error(`文档超过 2 MiB：${locator}`);
    const localCopy = path.join(inputDir, `${id}.md`);
    await writeFile(localCopy, bytes);
    return {
      id,
      locator,
      kind: 'remote',
      privacy: 'public_remote',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      local_copy: path.relative(path.dirname(inputDir), localCopy).replaceAll('\\', '/'),
    };
  }
  const absolute = path.resolve(locator);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) throw new Error(`本地文档不存在或不是文件：${absolute}`);
  if (info.size > MAX_DOCUMENT_BYTES) throw new Error(`文档超过 2 MiB：${absolute}`);
  const bytes = await readFile(absolute);
  const extension = path.extname(absolute) || '.txt';
  const localCopy = path.join(inputDir, `${id}${extension}`);
  await copyFile(absolute, localCopy);
  return {
    id,
    locator: `private://${id}`,
    kind: 'local',
    privacy: 'private_local',
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    local_copy: path.relative(path.dirname(inputDir), localCopy).replaceAll('\\', '/'),
  };
}

async function writeNew(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
}

function withHash(object: AuthoringObject): AuthoringObject {
  return { ...object, content_hash: computeContentHash(object) };
}

function yaml(value: unknown): string {
  return YAML.stringify(value, { lineWidth: 0 });
}

function jsonl(values: AuthoringObject[]): string {
  return values.length === 0 ? '' : `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
}

export async function loadProjectInput(workspace: string): Promise<ProjectInput> {
  const text = await readFile(path.join(workspace, 'project-input.yaml'), 'utf8');
  return YAML.parse(text) as ProjectInput;
}

export async function initializeProjectWorkspace(
  workspace: string,
  options: ProjectInitOptions,
): Promise<ProjectInitResult> {
  const root = path.resolve(workspace);
  await mkdir(root, { recursive: true });
  try {
    await stat(path.join(root, 'project-input.yaml'));
    throw new Error(`工作区已经初始化：${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const snapshot = await resolveGitSnapshot(options.repository, options.ref, options.cacheDir);
  const workspaceKey = sha256(`${snapshot.projectRef.repo}\n${snapshot.projectRef.commit}`).slice(0, 16);
  const workspaceId = `project.${workspaceKey}`;
  const runId = `run.project.${workspaceKey}`;
  const ptkgDir = path.join(root, '.ptkg');
  const inputDir = path.join(ptkgDir, 'inputs');
  await mkdir(inputDir, { recursive: true });
  const documents: ProjectDocument[] = [];
  for (const [index, locator] of (options.documents ?? []).entries()) {
    documents.push(await readDocument(locator, index, inputDir));
  }
  const unresolved = options.goal?.trim()
    ? []
    : ['仓库可能包含多个项目目标；请在项目合同 checkpoint 选择或补充完整项目目标。'];
  const input: ProjectInput = {
    spec_version: 'ptkg-project-input@1',
    workspace_id: workspaceId,
    status: unresolved.length > 0 ? 'unresolved' : 'candidate',
    repository: {
      locator: snapshot.repositoryLocator,
      kind: snapshot.repositoryKind,
      requested_ref: snapshot.requestedRef,
      commit: snapshot.projectRef.commit,
      tree: snapshot.tree,
    },
    goal: options.goal?.trim() || null,
    curriculum_boundary: 'pre_project_readiness',
    documents,
    unresolved_questions: unresolved,
  };
  await writeNew(path.join(root, 'project-input.yaml'), yaml(input));
  await writeNew(path.join(root, '.gitignore'), '.ptkg/\n');
  await writeNew(path.join(root, 'run-manifest.yaml'), yaml({
    authoring_version: '0.1',
    run_id: runId,
    profile: 'authoring',
    project_ref: snapshot.projectRef,
    reports_dir: 'reports',
  }));

  const context = analyzerContext(snapshot, runId);
  const files = await context.listFiles();
  const analyzerResults = await runSourceAnalyzers(context);
  const facts = analyzerResults.flatMap((result) => result.facts).sort((a, b) => a.id.localeCompare(b.id));
  const buildEntries = files.filter((file) => path.posix.basename(file) === 'Cargo.toml');
  const testEntries = files.filter((file) => /(?:^|\/)(?:test|tests|test-suit)(?:\/|$)/i.test(file)).slice(0, 20);
  const sourceContract = withHash({
    spec_version: 'source-contract@0.1',
    id: `source-contract.${workspaceKey}`,
    run_id: runId,
    project_ref: snapshot.projectRef,
    status: input.status,
    input_refs: documents.map((document) => document.id),
    claims: [{
      id: `claim.${workspaceKey}.fixed-baseline`,
      statement: `作者链绑定固定 commit ${snapshot.projectRef.commit} 与 tree ${snapshot.tree}`,
      epistemic_status: 'verified_fact',
      source_refs: [`src.repo.${workspaceKey}`],
      anchor_refs: [],
      method: 'git',
      validity: { commit_bound: true, invalidates_on: ['project_ref_change'] },
    }],
    created_by: { actor_type: 'tool', actor_id: 'ptkg-project-init' },
    content_hash: '',
    created_at: new Date().toISOString(),
    repository: snapshot.projectRef.repo,
    target: input.goal ?? '待教师确认的完整系统项目目标',
    curriculum_boundary: 'pre_project_readiness',
    non_goals: ['不规划真实项目分工', '不评价个人项目贡献', '不要求真实 PR 或上游合并'],
    environment: { source: 'fixed_git_tree', analyzer: 'git+markdown+cargo+rust' },
    build: buildEntries.length > 0 ? ['cargo check --workspace'] : ['unresolved: build command'],
    tests: testEntries.length > 0 ? testEntries : ['unresolved: test entry'],
    unresolved_questions: unresolved,
    checkout: {
      expected_tree: snapshot.tree,
      candidates: [{ repository: snapshot.projectRef.repo, ref: snapshot.requestedRef ?? snapshot.projectRef.commit }],
    },
  });
  const coverage = withHash({
    spec_version: 'project-coverage@0.1',
    id: `coverage.${workspaceKey}`,
    run_id: runId,
    project_ref: snapshot.projectRef,
    status: 'unresolved',
    input_refs: [sourceContract.id],
    claims: [],
    created_by: { actor_type: 'tool', actor_id: 'ptkg-project-init' },
    content_hash: '',
    created_at: new Date().toISOString(),
    release_level: 'author_preview',
    required_unit_ids: [`coverage.${workspaceKey}.full-project`],
    units: [{
      id: `coverage.${workspaceKey}.full-project`,
      title: '完整项目覆盖待 Agent 自顶向下拆解',
      required: true,
      critical: true,
      status: 'unresolved',
      implementation_state: 'unresolved',
      source_refs: [],
    }],
    platform_family: { id: `platform.${workspaceKey}`, shared_trunk_refs: [] },
    reuse_links: [],
  });

  await Promise.all([
    writeNew(path.join(root, '01-source', 'source-contract.yaml'), yaml(sourceContract)),
    writeNew(path.join(root, '02-facts', 'code-facts.jsonl'), jsonl(facts)),
    writeNew(path.join(root, '03-coverage', 'project-coverage.yaml'), yaml(coverage)),
    writeNew(path.join(root, '04-behaviors', 'behavior-chains.jsonl'), ''),
    writeNew(path.join(root, '05-slices', 'learning-slices.jsonl'), ''),
    writeNew(path.join(root, '06-execution', 'execution-results.jsonl'), ''),
    writeNew(path.join(root, '08-governance', 'review-events.jsonl'), ''),
    writeNew(path.join(root, '08-governance', 'exception-events.jsonl'), ''),
    writeNew(path.join(root, '07-projection', 'manifest.yaml'), yaml({
      ptkg_version: '0.1',
      bundle_id: `bundle.${workspaceKey}`,
      title: input.goal ?? '待确认项目 PTKG projection',
      status: 'draft',
      project_ref: { repository_url: snapshot.projectRef.repo, git_ref: snapshot.projectRef.commit },
      generator: { tool: 'os-camp-ptkg', tool_version: '0.2.0' },
      files: { nodes: 'nodes.jsonl', edges: 'edges.jsonl', sources: 'sources.jsonl' },
    })),
    writeNew(path.join(root, '07-projection', 'nodes.jsonl'), ''),
    writeNew(path.join(root, '07-projection', 'edges.jsonl'), ''),
    writeNew(path.join(root, '07-projection', 'sources.jsonl'), ''),
    writeNew(path.join(root, '09-course', 'README.md'), '# Course asset checkpoint\n\n由第五个 checkpoint 生成候选课程资产；当前目录不代表课程已经完成。\n'),
    writeNew(path.join(ptkgDir, 'source.json'), `${JSON.stringify(snapshot, null, 2)}\n`),
    writeNew(path.join(ptkgDir, 'analyzers.json'), `${JSON.stringify(analyzerResults.map((result) => ({
      analyzer: result.analyzer,
      capability: result.capability,
      facts: result.facts.length,
      warnings: result.warnings,
    })), null, 2)}\n`),
  ]);
  await Promise.all([
    mkdir(path.join(root, 'reports'), { recursive: true }),
    mkdir(path.join(ptkgDir, 'instructions'), { recursive: true }),
    mkdir(path.join(ptkgDir, 'logs'), { recursive: true }),
  ]);
  await verifyAuthoringWorkspace(root, options.cacheDir ?? defaultProjectCacheDir());
  const status = await getProjectStatus(root);
  await writeFile(path.join(ptkgDir, 'state.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  return { input, snapshot, analyzerResults, status };
}
