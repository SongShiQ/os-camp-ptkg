import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { computeContentHash } from './hash.ts';
import { loadAuthoringRun } from './loader.ts';
import {
  hashRuntimePrepareCommand,
  verifyRuntimeCache,
  writeRuntimeCacheManifest,
  type RuntimeCacheIdentity,
  type VerifiedRuntimeCache,
} from './runtime.ts';
import type { AuthoringObject, AuthoringRun } from './types.ts';
import { verifyAuthoringWorkspace } from './workspace.ts';

const execFileAsync = promisify(execFile);
const IMAGE_DIGEST = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const FAULT_DETECTED_PREFIX = 'PTKG_SEEDED_FAULT_DETECTED:';

type TestClasses = {
  positive: boolean;
  negative: boolean;
  concurrency: boolean | 'not_applicable';
  regression: boolean;
};

export interface ExecutionOptions {
  sliceId: string;
  image: string;
  command: string;
  faultCommand?: string;
  faultRef?: string;
  expected?: string;
  testClasses?: TestClasses;
  timeoutSeconds?: number;
  memoryMb?: number;
  processes?: number;
  cacheDir?: string;
  runtimeCache?: string;
}

export interface ExecutionRunResult {
  result: AuthoringObject;
  stdout: string;
  stderr: string;
}

export interface RuntimePreparationOptions {
  image: string;
  command: string;
  outDir: string;
  timeoutSeconds?: number;
  memoryMb?: number;
  processes?: number;
  cacheDir?: string;
}

export interface RuntimePreparationResult {
  status: 'ready' | 'failed';
  exit_code: number;
  cache_dir: string;
  root_hash?: string;
  file_count?: number;
  total_bytes?: number;
  stdout_file: string;
  stderr_file: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface VerifiedSnapshot {
  cacheRepo: string;
  tree: string;
}

interface DisposableWorktree {
  root: string;
  source: string;
  cacheRepo: string;
}

interface ResetStep {
  succeeded: boolean;
  log: string;
}

interface VerifiedImage {
  id: string;
  repoDigests: string[];
}

interface DockerRuntimeMounts {
  readOnlyAssets: string;
  writableAssets: string;
  initialize: boolean;
}

const GIT_RUNTIME_OPTIONS = ['-c', 'core.longpaths=true'];

/**
 * Windows has a 260-character compatibility boundary in parts of the Git and
 * Node toolchain. Keep disposable workers near the drive root there, while
 * allowing an explicit absolute override for controlled CI environments.
 */
export function resolveWorkerBase(
  rootDir: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const configured = environment.PTKG_WORKER_DIR;
  if (configured) {
    if (!paths.isAbsolute(configured)) throw new Error('PTKG_WORKER_DIR 必须是绝对路径。');
    return paths.resolve(configured);
  }
  if (platform === 'win32') return paths.join(paths.parse(paths.resolve(rootDir)).root, 'ptkg-workers');
  return paths.join(paths.resolve(rootDir), '.ptkg', 'workers');
}

/** Worktree materialization must preserve LF bytes from the frozen Git tree. */
export function frozenCheckoutGitOptions(): string[] {
  return ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'];
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function declaredExecutionId(slice: AuthoringObject): string {
  const refs = Array.isArray(slice.execution_refs)
    ? slice.execution_refs.filter((value): value is string => typeof value === 'string')
    : [];
  const [id] = refs;
  if (refs.length !== 1 || !id) {
    throw new Error(`learning-slice ${slice.id} 必须声明且只能声明一个 execution_refs，当前为 ${refs.length} 个。`);
  }
  if (!/^exec\.[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`learning-slice ${slice.id} 的 execution_refs 不是稳定 exec.* ID：${id}`);
  }
  return id;
}

function asExitCode(error: unknown): number {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'number') {
    return (error as { code: number }).code;
  }
  return -1;
}

async function capture(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
  try {
    const output = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { exitCode: 0, stdout: output.stdout, stderr: output.stderr, timedOut: false };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string };
    return {
      exitCode: asExitCode(error),
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? String(error),
      timedOut: failure.killed === true || failure.signal === 'SIGTERM',
    };
  }
}

async function captureGit(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
  return capture('git', [...GIT_RUNTIME_OPTIONS, ...args], options);
}

async function git(args: string[], cwd?: string): Promise<string> {
  const output = await captureGit(args, { cwd, timeoutMs: 120_000 });
  if (output.exitCode !== 0) throw new Error(output.stderr.trim() || `git ${args.join(' ')} failed`);
  return output.stdout.trim();
}

async function readVerifiedSnapshot(runDir: string, run: AuthoringRun, cacheDir?: string): Promise<VerifiedSnapshot> {
  const checkout = run.sourceContract.checkout && typeof run.sourceContract.checkout === 'object' && !Array.isArray(run.sourceContract.checkout)
    ? run.sourceContract.checkout as Record<string, unknown>
    : {};
  const expectedTree = typeof checkout.expected_tree === 'string' ? checkout.expected_tree : '';
  try {
    const value = JSON.parse(await readFile(path.join(runDir, '02-facts', 'workspace-verification.json'), 'utf8')) as {
      project_ref?: { repo?: string; commit?: string };
      tree?: string;
      cache_repo?: string;
    };
    if (
      value.project_ref?.repo === run.sourceContract.project_ref.repo
      && value.project_ref.commit === run.sourceContract.project_ref.commit
      && typeof value.cache_repo === 'string'
      && path.isAbsolute(value.cache_repo)
      && typeof value.tree === 'string'
      && SHA40.test(value.tree)
      && value.tree === expectedTree
    ) {
      const [kind, tree] = await Promise.all([
        git([`--git-dir=${value.cache_repo}`, 'cat-file', '-t', run.sourceContract.project_ref.commit]),
        git([`--git-dir=${value.cache_repo}`, 'show', '-s', '--format=%T', run.sourceContract.project_ref.commit]),
      ]);
      if (kind === 'commit' && tree === value.tree) return { cacheRepo: value.cache_repo, tree };
    }
  } catch {
    // Rebuild the verification index below when it is missing, stale, or unreadable.
  }
  const verified = await verifyAuthoringWorkspace(runDir, cacheDir);
  return { cacheRepo: verified.cache_repo, tree: verified.tree };
}

async function createWorktree(snapshot: VerifiedSnapshot, commit: string, workerBase: string): Promise<DisposableWorktree> {
  await mkdir(workerBase, { recursive: true });
  const root = await mkdtemp(path.join(workerBase, 'worker-'));
  const source = path.join(root, 'source');
  let registered = false;
  try {
    await git([
      ...frozenCheckoutGitOptions(),
      `--git-dir=${snapshot.cacheRepo}`,
      'worktree', 'add', '--detach', source, commit,
    ]);
    registered = true;
    const [actualCommit, actualTree] = await Promise.all([
      git(['rev-parse', 'HEAD'], source),
      git(['show', '-s', '--format=%T', 'HEAD'], source),
    ]);
    if (actualCommit !== commit || actualTree !== snapshot.tree) {
      throw new Error(`disposable worktree identity mismatch: ${actualCommit}/${actualTree}`);
    }
    return { root, source, cacheRepo: snapshot.cacheRepo };
  } catch (error) {
    if (registered) {
      await captureGit([`--git-dir=${snapshot.cacheRepo}`, 'worktree', 'remove', '--force', source], { timeoutMs: 120_000 });
      await captureGit([`--git-dir=${snapshot.cacheRepo}`, 'worktree', 'prune'], { timeoutMs: 120_000 });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => path.resolve(value).replaceAll('\\', '/').toLowerCase();
  return normalize(left) === normalize(right);
}

async function resetWorktree(worktree: DisposableWorktree, commit: string, tree: string): Promise<ResetStep> {
  const messages: string[] = [];
  try {
    await git(['reset', '--hard', commit], worktree.source);
    messages.push('tracked files reset to the fixed commit');
    await git(['clean', '-fdx'], worktree.source);
    messages.push('untracked and ignored files removed');
    const [actualCommit, actualTree, status] = await Promise.all([
      git(['rev-parse', 'HEAD'], worktree.source),
      git(['show', '-s', '--format=%T', 'HEAD'], worktree.source),
      git(['status', '--porcelain=v1', '--untracked-files=all'], worktree.source),
    ]);
    if (actualCommit !== commit || actualTree !== tree || status !== '') {
      throw new Error(`reset verification mismatch: commit=${actualCommit} tree=${actualTree} dirty=${status !== ''}`);
    }
    return { succeeded: true, log: messages.join('\n') };
  } catch (error) {
    return { succeeded: false, log: [...messages, `reset failed: ${(error as Error).message}`].join('\n') };
  }
}

async function removeWorktree(worktree: DisposableWorktree | null): Promise<ResetStep> {
  if (!worktree) return { succeeded: true, log: 'worktree was not created' };
  const messages: string[] = [];
  try {
    const status = await git(['status', '--porcelain=v1', '--untracked-files=all'], worktree.source);
    messages.push(status ? `discarded changes:\n${status}` : 'worktree remained clean');
  } catch (error) {
    messages.push(`status unavailable: ${(error as Error).message}`);
  }
  const removal = await captureGit(
    [`--git-dir=${worktree.cacheRepo}`, 'worktree', 'remove', '--force', worktree.source],
    { timeoutMs: 120_000 },
  );
  messages.push(removal.exitCode === 0 ? 'git worktree registration removed' : `git worktree remove failed: ${removal.stderr}`);
  const prune = await captureGit([`--git-dir=${worktree.cacheRepo}`, 'worktree', 'prune'], { timeoutMs: 120_000 });
  messages.push(prune.exitCode === 0 ? 'git worktree registry pruned' : `git worktree prune failed: ${prune.stderr}`);
  try {
    await rm(worktree.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  } catch (error) {
    messages.push(`worker root removal failed: ${(error as Error).message}`);
  }
  let rootRemoved = false;
  try {
    await stat(worktree.root);
    messages.push('worker root still exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      messages.push(`cleanup verification failed: ${(error as Error).message}`);
    } else {
      rootRemoved = true;
    }
  }
  let registrationRemoved = false;
  try {
    const registry = await git([`--git-dir=${worktree.cacheRepo}`, 'worktree', 'list', '--porcelain']);
    const registeredPaths = registry
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
    registrationRemoved = !registeredPaths.some((entry) => samePath(entry, worktree.source));
    if (!registrationRemoved) messages.push('worktree registration still exists');
  } catch (error) {
    messages.push(`registry verification failed: ${(error as Error).message}`);
  }
  return { succeeded: rootRemoved && registrationRemoved, log: messages.join('\n') };
}

function runtimeEnvironment(offline: boolean): string[] {
  return [
    '--env', 'RUSTUP_HOME=/runtime/rustup',
    '--env', 'RUSTUP_TOOLCHAIN=nightly-2026-05-28-x86_64-unknown-linux-gnu',
    '--env', 'CARGO_HOME=/runtime/cargo',
    '--env', 'CARGO_TARGET_DIR=/runtime/target',
    '--env', 'TGOS_IMAGE_LOCAL_STORAGE=/runtime/images',
    '--env', 'PTKG_WORKSPACE_OVERLAY=/runtime/workspace',
    ...(offline ? [
      '--env', 'CARGO_NET_OFFLINE=true',
      '--env', 'RUSTUP_SKIP_UPDATE_CHECK=1',
    ] : []),
  ];
}

export function runtimeShellCommand(command: string, initialize: boolean): string {
  // Runtime assets are mounted individually below. Keeping this parameter
  // preserves the call contract while preventing an 8+ GB cache copy.
  void initialize;
  const restoreOverlay = 'if [ -d /runtime/workspace ]; then cp -a /runtime/workspace/. /workspace/; fi && ';
  return `${restoreOverlay}export PATH="/runtime/cargo/bin:$PATH"; ${command}`;
}

/**
 * axbuild explicitly writes to <workspace>/target, bypassing CARGO_TARGET_DIR.
 * Bind that ignored directory to the writable runtime copy so a preparation
 * build survives its disposable worktree and formal runs can reuse it.
 */
export function runtimeTargetMountArgs(runtimeTarget: string): string[] {
  return ['--mount', `type=bind,src=${runtimeTarget},dst=/workspace/target`];
}

/** Seed only assets that need writes; toolchains and source overlays stay read-only. */
export async function seedRuntimeWritableAssets(readOnlyAssets: string, writableAssets: string): Promise<void> {
  await mkdir(writableAssets, { recursive: true });
  await Promise.all(['target', 'images'].map((entry) => cp(
    path.join(readOnlyAssets, entry),
    path.join(writableAssets, entry),
    {
      recursive: true,
      // A new Git worktree has fresh source mtimes. Refresh target mtimes so
      // Cargo can reuse the verified artifacts instead of rebuilding them.
      preserveTimestamps: entry !== 'target',
    },
  )));
}

function dockerArgs(
  image: string,
  worktree: string,
  command: string,
  memoryMb: number,
  processes: number,
  runtime?: DockerRuntimeMounts,
): string[] {
  const user = typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? ['--user', `${process.getuid()}:${process.getgid()}`]
    : [];
  const runtimeMounts = runtime ? [
    '--mount', `type=bind,src=${path.join(runtime.readOnlyAssets, 'cargo')},dst=/runtime/cargo,readonly`,
    '--mount', `type=bind,src=${path.join(runtime.readOnlyAssets, 'rustup')},dst=/runtime/rustup,readonly`,
    '--mount', `type=bind,src=${path.join(runtime.writableAssets, 'images')},dst=/runtime/images`,
    '--mount', `type=bind,src=${path.join(runtime.readOnlyAssets, 'workspace')},dst=/runtime/workspace,readonly`,
    '--mount', `type=bind,src=${path.join(runtime.readOnlyAssets, 'firmware.sha256')},dst=/runtime/firmware.sha256,readonly`,
    '--mount', `type=bind,src=${path.join(runtime.writableAssets, 'target')},dst=/runtime/target`,
    ...runtimeTargetMountArgs(path.join(runtime.writableAssets, 'target')),
    ...runtimeEnvironment(true),
  ] : [];
  const effectiveCommand = runtime ? runtimeShellCommand(command, runtime.initialize) : command;
  return [
    'run', '--rm', '--network', 'none', '--pull', 'never',
    '--memory', `${memoryMb}m`, '--pids-limit', String(processes),
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...user,
    '--mount', `type=bind,src=${worktree},dst=/workspace`,
    ...runtimeMounts,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456',
    '--workdir', '/workspace', '--entrypoint', 'sh',
    image, '-lc', effectiveCommand,
  ];
}

function runtimePrepareDockerArgs(
  image: string,
  worktree: string,
  assets: string,
  command: string,
  memoryMb: number,
  processes: number,
): string[] {
  const user = typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? ['--user', `${process.getuid()}:${process.getgid()}`]
    : [];
  return [
    'run', '--rm', '--network', 'bridge', '--pull', 'never',
    '--memory', `${memoryMb}m`, '--pids-limit', String(processes),
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...user,
    '--mount', `type=bind,src=${worktree},dst=/workspace`,
    '--mount', `type=bind,src=${assets},dst=/runtime`,
    ...runtimeTargetMountArgs(path.join(assets, 'target')),
    ...runtimeEnvironment(false),
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=1073741824',
    '--workdir', '/workspace', '--entrypoint', 'sh',
    image, '-lc', runtimeShellCommand(command, false),
  ];
}

function displayedDockerCommand(args: string[]): string {
  const sanitized = args.map((value) => {
    if (!value.startsWith('type=bind,src=')) return value;
    const destination = value.split(',').find((part) => part.startsWith('dst=')) ?? 'dst=<container-path>';
    const readOnly = value.endsWith(',readonly') ? ',readonly' : '';
    return `type=bind,src=<host-path>,${destination}${readOnly}`;
  });
  return ['docker', ...sanitized].map((value) => /\s/.test(value) ? JSON.stringify(value) : value).join(' ');
}

async function inspectFixedImage(image: string): Promise<VerifiedImage> {
  const inspect = await capture('docker', ['image', 'inspect', image, '--format', '{{json .}}'], { timeoutMs: 60_000 });
  if (inspect.exitCode !== 0) throw new Error(inspect.stderr.trim() || `fixed image is unavailable: ${image}`);
  const value = JSON.parse(inspect.stdout) as { Id?: string; RepoDigests?: string[] };
  const id = value.Id ?? '';
  const repoDigests = Array.isArray(value.RepoDigests) ? value.RepoDigests : [];
  if (!id || !repoDigests.includes(image)) throw new Error(`image inspect did not confirm requested digest: ${image}`);
  return { id, repoDigests };
}

/** Runtime overlays may add generated inputs, but must never replace frozen source. */
export async function verifyRuntimeWorkspaceOverlay(
  runtimeCache: VerifiedRuntimeCache,
  cacheRepo: string,
  commit: string,
): Promise<string[]> {
  const overlayEntries = runtimeCache.files.filter((entry) => entry.path.startsWith('workspace/'));
  const paths: string[] = [];
  for (const entry of overlayEntries) {
    const relative = entry.path.slice('workspace/'.length);
    if (!relative || relative === '.git' || relative.startsWith('.git/')) {
      throw new Error(`runtime workspace overlay 禁止写入 Git 元数据：${entry.path}`);
    }
    if (entry.kind === 'symlink') {
      const target = entry.target ?? '';
      const resolved = path.posix.resolve('/workspace', path.posix.dirname(relative), target);
      if (!resolved.startsWith('/workspace/')) {
        throw new Error(`runtime workspace overlay 符号链接越界：${entry.path} -> ${target}`);
      }
    }
    const tracked = await git([
      `--git-dir=${cacheRepo}`,
      'ls-tree', '-r', '--name-only', commit, '--', relative,
    ]);
    if (tracked.split(/\r?\n/).some((value) => value === relative)) {
      throw new Error(`runtime workspace overlay 禁止覆盖固定源码：${relative}`);
    }
    paths.push(relative);
  }
  return paths.sort();
}

function inheritedClaimRefs(run: AuthoringRun, slice: AuthoringObject): { sourceRefs: string[]; anchorRefs: string[] } {
  const behavior = run.behaviorChains.find((item) => item.id === slice.behavior_ref);
  const sourceRefs = new Set<string>();
  const anchorRefs = new Set<string>();
  for (const claim of behavior?.claims ?? []) {
    for (const value of claim.source_refs) sourceRefs.add(value);
    for (const value of claim.anchor_refs) anchorRefs.add(value);
  }
  return { sourceRefs: [...sourceRefs].sort(), anchorRefs: [...anchorRefs].sort() };
}

function defaultTestClasses(succeeded: boolean): TestClasses {
  return {
    positive: succeeded,
    negative: false,
    concurrency: 'not_applicable',
    regression: false,
  };
}

/** A non-zero process exit alone is not proof that the seeded fault was detected. */
export function hasSeededFaultEvidence(
  exitCode: number,
  timedOut: boolean,
  stdout: string,
  stderr: string,
  faultRef: string,
): boolean {
  if (exitCode <= 0 || timedOut) return false;
  const expected = `${FAULT_DETECTED_PREFIX}${faultRef}`;
  return `${stdout}\n${stderr}`.split(/\r?\n/).some((line) => line.trim() === expected);
}

async function readJsonIfPresent(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Populate a local runtime cache in a network-enabled preparation phase. The
 * resulting cache is source/image-bound and must be re-verified before a
 * network-disabled evidence run consumes it.
 */
export async function prepareAuthoringRuntime(
  runDir: string,
  options: RuntimePreparationOptions,
): Promise<RuntimePreparationResult> {
  if (!IMAGE_DIGEST.test(options.image)) throw new Error('--image 必须是 name@sha256:<64位 digest>，禁止浮动 tag。');
  const rootDir = path.resolve(runDir);
  const output = path.resolve(options.outDir);
  const assets = path.join(output, 'assets');
  const logs = path.join(output, 'logs');
  const stdoutFile = path.join(logs, 'prepare.stdout.log');
  const stderrFile = path.join(logs, 'prepare.stderr.log');
  const timeoutSeconds = options.timeoutSeconds ?? 7_200;
  const memoryMb = options.memoryMb ?? 8_192;
  const processes = options.processes ?? 512;
  if (![timeoutSeconds, memoryMb, processes].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error('资源限制必须是正整数。');
  }

  const loaded = await loadAuthoringRun(rootDir);
  if (!loaded.run) throw new Error(`无法载入作者运行：${loaded.findings.map((item) => item.message).join('；')}`);
  const run = loaded.run;
  const snapshot = await readVerifiedSnapshot(rootDir, run, options.cacheDir);
  const image = await inspectFixedImage(options.image);
  const identity: RuntimeCacheIdentity = {
    project_ref: run.sourceContract.project_ref,
    tree: snapshot.tree,
    image: { reference: options.image, id: image.id, repo_digests: [...image.repoDigests].sort() },
    prepare_command_hash: hashRuntimePrepareCommand(options.command),
  };
  const inputRecord = {
    spec_version: 'ptkg-runtime-input@1',
    ...identity,
  };

  await Promise.all([
    mkdir(path.join(assets, 'rustup'), { recursive: true }),
    mkdir(path.join(assets, 'cargo'), { recursive: true }),
    mkdir(path.join(assets, 'target'), { recursive: true }),
    mkdir(path.join(assets, 'images'), { recursive: true }),
    mkdir(path.join(assets, 'workspace'), { recursive: true }),
    mkdir(logs, { recursive: true }),
  ]);
  const inputFile = path.join(output, 'prepare-input.json');
  const existingInput = await readJsonIfPresent(inputFile);
  if (existingInput && JSON.stringify(existingInput) !== JSON.stringify(inputRecord)) {
    throw new Error('runtime cache 已包含不同的源码、镜像或准备命令，拒绝混用。');
  }
  await writeFile(inputFile, `${JSON.stringify(inputRecord, null, 2)}\n`, 'utf8');

  try {
    await stat(path.join(output, 'runtime-manifest.json'));
    const verified = await verifyRuntimeCache(output, {
      project_ref: identity.project_ref,
      tree: identity.tree,
      image_reference: identity.image.reference,
      image_id: identity.image.id,
    });
    if (verified.manifest.prepare_command_hash !== identity.prepare_command_hash) {
      throw new Error('runtime cache 的准备命令 hash 与请求不一致。');
    }
    return {
      status: 'ready',
      exit_code: 0,
      cache_dir: output,
      root_hash: verified.manifest.root_hash,
      file_count: verified.manifest.file_count,
      total_bytes: verified.manifest.total_bytes,
      stdout_file: stdoutFile,
      stderr_file: stderrFile,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  let worktree: DisposableWorktree | null = null;
  let commandResult: CommandResult = { exitCode: -1, stdout: '', stderr: '', timedOut: false };
  let setupError = '';
  try {
    worktree = await createWorktree(snapshot, run.sourceContract.project_ref.commit, resolveWorkerBase(rootDir));
    await mkdir(path.join(worktree.source, 'target'), { recursive: true });
    const args = runtimePrepareDockerArgs(options.image, worktree.source, assets, options.command, memoryMb, processes);
    commandResult = await capture('docker', args, { cwd: rootDir, timeoutMs: timeoutSeconds * 1_000 });
  } catch (error) {
    setupError = (error as Error).message;
  }
  const cleanup = await removeWorktree(worktree);
  const stderr = [commandResult.stderr, setupError ? `[setup]\n${setupError}` : '', cleanup.log]
    .filter(Boolean)
    .join('\n');
  await Promise.all([
    writeFile(stdoutFile, commandResult.stdout, 'utf8'),
    writeFile(stderrFile, stderr, 'utf8'),
  ]);
  if (commandResult.exitCode !== 0 || commandResult.timedOut || setupError || !cleanup.succeeded) {
    return {
      status: 'failed',
      exit_code: commandResult.exitCode,
      cache_dir: output,
      stdout_file: stdoutFile,
      stderr_file: stderrFile,
    };
  }

  const verified = await writeRuntimeCacheManifest(output, identity);
  return {
    status: 'ready',
    exit_code: 0,
    cache_dir: output,
    root_hash: verified.manifest.root_hash,
    file_count: verified.manifest.file_count,
    total_bytes: verified.manifest.total_bytes,
    stdout_file: stdoutFile,
    stderr_file: stderrFile,
  };
}

async function upsertExecutionResult(file: string, result: AuthoringObject): Promise<void> {
  let existing: AuthoringObject[] = [];
  try {
    existing = (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as AuthoringObject);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const values = new Map(existing.map((item) => [item.id, item]));
  values.set(result.id, result);
  const output = [...values.values()].sort((a, b) => a.id.localeCompare(b.id));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${output.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
}

/**
 * Run one slice against a verified fixed-source disposable worktree. The
 * container has no network or host secrets; failures still produce auditable
 * unresolved evidence and the worktree is always discarded.
 */
export async function executeAuthoringSlice(runDir: string, options: ExecutionOptions): Promise<ExecutionRunResult> {
  if (!IMAGE_DIGEST.test(options.image)) throw new Error('--image 必须是 name@sha256:<64位 digest>，禁止浮动 tag。');
  if ((options.faultCommand && !options.faultRef) || (!options.faultCommand && options.faultRef)) {
    throw new Error('--fault-command 与 --fault-ref 必须同时提供。');
  }
  const rootDir = path.resolve(runDir);
  const loaded = await loadAuthoringRun(rootDir);
  if (!loaded.run) throw new Error(`无法载入作者运行：${loaded.findings.map((item) => item.message).join('；')}`);
  const run = loaded.run;
  const slice = run.learningSlices.find((item) => item.id === options.sliceId);
  if (!slice) throw new Error(`找不到 learning-slice：${options.sliceId}`);
  const id = declaredExecutionId(slice);
  const timeoutSeconds = options.timeoutSeconds ?? 600;
  const memoryMb = options.memoryMb ?? 4096;
  const processes = options.processes ?? 128;
  if (![timeoutSeconds, memoryMb, processes].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error('资源限制必须是正整数。');
  }

  const started = Date.now();
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  const phases: Array<{ name: 'baseline' | 'fault'; exit_code: number; timed_out: boolean; expected: string }> = [];
  const commands: string[] = [];
  let worktree: DisposableWorktree | null = null;
  let sourceSnapshot: { repo: string; commit: string; tree: string } | null = null;
  let imageId: string | null = null;
  let imageDigests: string[] = [];
  let baseline: CommandResult | null = null;
  let fault: CommandResult | null = null;
  let setupError = '';
  let beforeFaultReset: ResetStep | null = null;
  let runtimeCache: VerifiedRuntimeCache | null = null;
  let runtimeWorking: string | null = null;
  let runtimeUnchanged = true;

  try {
    const snapshot = await readVerifiedSnapshot(rootDir, run, options.cacheDir);
    sourceSnapshot = { ...run.sourceContract.project_ref, tree: snapshot.tree };
    worktree = await createWorktree(
      snapshot,
      run.sourceContract.project_ref.commit,
      resolveWorkerBase(rootDir),
    );
    commands.push(displayedDockerCommand(['image', 'inspect', options.image, '--format', '{{json .}}']));
    const image = await inspectFixedImage(options.image);
    imageId = image.id;
    imageDigests = image.repoDigests;
    if (options.runtimeCache) {
      runtimeCache = await verifyRuntimeCache(options.runtimeCache, {
        project_ref: run.sourceContract.project_ref,
        tree: snapshot.tree,
        image_reference: options.image,
        image_id: image.id,
      });
      await verifyRuntimeWorkspaceOverlay(runtimeCache, snapshot.cacheRepo, run.sourceContract.project_ref.commit);
      runtimeUnchanged = false;
      runtimeWorking = path.join(worktree.root, 'runtime');
      await seedRuntimeWritableAssets(runtimeCache.assets, runtimeWorking);
      await mkdir(path.join(worktree.source, 'target'), { recursive: true });
    }

    const baselineArgs = dockerArgs(
      options.image,
      worktree.source,
      options.command,
      memoryMb,
      processes,
      runtimeCache && runtimeWorking ? {
        readOnlyAssets: runtimeCache.assets,
        writableAssets: runtimeWorking,
        initialize: true,
      } : undefined,
    );
    commands.push(displayedDockerCommand(baselineArgs));
    baseline = await capture('docker', baselineArgs, { cwd: rootDir, timeoutMs: timeoutSeconds * 1000 });
    stdoutParts.push(`[baseline]\n${baseline.stdout}`);
    stderrParts.push(`[baseline]\n${baseline.stderr}`);
    phases.push({ name: 'baseline', exit_code: baseline.exitCode, timed_out: baseline.timedOut, expected: 'exit 0' });

    if (baseline.exitCode === 0 && baseline.timedOut === false && options.faultCommand && options.faultRef) {
      beforeFaultReset = await resetWorktree(worktree, run.sourceContract.project_ref.commit, snapshot.tree);
      if (!beforeFaultReset.succeeded) throw new Error(`seeded fault 前无法恢复固定源码：${beforeFaultReset.log}`);
      if (runtimeWorking) await mkdir(path.join(worktree.source, 'target'), { recursive: true });
      const faultArgs = dockerArgs(
        options.image,
        worktree.source,
        options.faultCommand,
        memoryMb,
        processes,
        runtimeCache && runtimeWorking ? {
          readOnlyAssets: runtimeCache.assets,
          writableAssets: runtimeWorking,
          initialize: false,
        } : undefined,
      );
      commands.push(displayedDockerCommand(faultArgs));
      fault = await capture('docker', faultArgs, { cwd: rootDir, timeoutMs: timeoutSeconds * 1000 });
      stdoutParts.push(`[fault]\n${fault.stdout}`);
      stderrParts.push(`[fault]\n${fault.stderr}`);
      phases.push({
        name: 'fault',
        exit_code: fault.exitCode,
        timed_out: fault.timedOut,
        expected: `non-zero test exit and marker ${FAULT_DETECTED_PREFIX}${options.faultRef}`,
      });
    }
    if (runtimeCache) {
      const after = await verifyRuntimeCache(runtimeCache.root, {
        project_ref: run.sourceContract.project_ref,
        tree: snapshot.tree,
        image_reference: options.image,
        image_id: image.id,
      });
      runtimeUnchanged = after.manifest.root_hash === runtimeCache.manifest.root_hash;
      if (!runtimeUnchanged) throw new Error('正式执行后 runtime cache root hash 发生变化。');
    }
  } catch (error) {
    setupError = (error as Error).message;
    stderrParts.push(`[setup]\n${setupError}`);
  }

  const cleanup = await removeWorktree(worktree);
  const resetEvidence = {
    ...(beforeFaultReset ? { before_fault: beforeFaultReset } : {}),
    ...(runtimeCache ? {
      runtime_cache: { root_hash: runtimeCache.manifest.root_hash, unchanged: runtimeUnchanged },
    } : {}),
    cleanup,
  };
  const baselinePassed = baseline?.exitCode === 0 && baseline.timedOut === false;
  const faultFailed = fault !== null && options.faultRef !== undefined && hasSeededFaultEvidence(
    fault.exitCode,
    fault.timedOut,
    fault.stdout,
    fault.stderr,
    options.faultRef,
  );
  const refs = inheritedClaimRefs(run, slice);
  const evidenceBound = refs.sourceRefs.length + refs.anchorRefs.length > 0;
  const resetSucceeded = cleanup.succeeded && (!beforeFaultReset || beforeFaultReset.succeeded) && runtimeUnchanged;
  const succeeded = Boolean(baselinePassed && (!options.faultCommand || faultFailed) && resetSucceeded && !setupError && evidenceBound);
  const resultStatus: 'succeeded' | 'failed' = succeeded ? 'succeeded' : 'failed';
  const stdout = stdoutParts.join('\n');
  const stderr = stderrParts.join('\n');
  const sandbox = { network: 'disabled', filesystem: 'disposable_worktree', secrets: 'none', resettable: true, push_allowed: false } as const;
  const environment = {
    image: { reference: options.image, id: imageId, repo_digests: imageDigests, verified: imageId !== null && imageDigests.includes(options.image) },
    source: sourceSnapshot ?? { ...run.sourceContract.project_ref, tree: null, verified: false },
    sandbox,
    limits: { timeout_seconds: timeoutSeconds, memory_mb: memoryMb, processes },
    ...(runtimeCache ? {
      runtime_cache: {
        spec_version: runtimeCache.manifest.spec_version,
        root_hash: runtimeCache.manifest.root_hash,
        files_hash: runtimeCache.manifest.files_hash,
        prepare_command_hash: runtimeCache.manifest.prepare_command_hash,
        file_count: runtimeCache.manifest.file_count,
        total_bytes: runtimeCache.manifest.total_bytes,
        verified_unchanged: runtimeUnchanged,
      },
    } : {}),
  };
  const actual = setupError
    ? '执行环境未就绪；原始错误仅保存在本地 stderr artifact。'
    : succeeded
      ? options.faultCommand
        ? '基线通过，seeded fault 被测试以非零退出识别，worktree 已清理。'
        : '基线命令通过，worktree 已清理。'
      : `执行未满足预期：baseline=${baseline?.exitCode ?? 'not-run'} fault=${fault?.exitCode ?? 'not-run'} reset=${resetSucceeded}`;

  const artifactRoot = path.join(rootDir, run.manifest.reports_dir, 'execution', id);
  const artifactPrefix = path.posix.join(run.manifest.reports_dir, 'execution', id);
  await mkdir(artifactRoot, { recursive: true });
  const environmentText = `${JSON.stringify(environment, null, 2)}\n`;
  const phasesText = `${JSON.stringify(phases, null, 2)}\n`;
  const resetText = `${JSON.stringify(resetEvidence, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(artifactRoot, 'stdout.log'), stdout, 'utf8'),
    writeFile(path.join(artifactRoot, 'stderr.log'), stderr, 'utf8'),
    writeFile(path.join(artifactRoot, 'environment.json'), environmentText, 'utf8'),
    writeFile(path.join(artifactRoot, 'phases.json'), phasesText, 'utf8'),
    writeFile(path.join(artifactRoot, 'reset.json'), resetText, 'utf8'),
  ]);

  const result: AuthoringObject = {
    spec_version: 'execution-result@0.1',
    id,
    run_id: run.manifest.run_id,
    project_ref: run.sourceContract.project_ref,
    status: succeeded ? 'candidate' : 'unresolved',
    input_refs: [options.sliceId],
    claims: [{
      id: `claim.${id}`,
      statement: succeeded ? '固定源码在隔离容器中满足声明的执行预期。' : `隔离执行未完成：${actual}`,
      epistemic_status: succeeded ? 'verified_fact' : 'unresolved',
      source_refs: refs.sourceRefs,
      anchor_refs: refs.anchorRefs,
      method: 'test',
      ...(succeeded ? { verified_at: new Date().toISOString() } : {}),
      validity: { commit_bound: true, invalidates_on: ['environment_change', 'behavior_change', 'test_change'] },
    }],
    created_by: { actor_type: 'tool', actor_id: 'isolated-worker' },
    content_hash: '',
    created_at: new Date().toISOString(),
    slice_ref: options.sliceId,
    result_status: resultStatus,
    environment_hash: sha256(JSON.stringify(environment)),
    toolchain_hash: sha256(JSON.stringify({
      requested_image: options.image,
      image_id: imageId,
      runtime_root: runtimeCache?.manifest.root_hash ?? null,
      commands,
    })),
    commands,
    exit_code: succeeded ? 0 : (baseline?.exitCode || fault?.exitCode || -1),
    artifact_hashes: [sha256(stdout), sha256(stderr), sha256(environmentText), sha256(phasesText), sha256(resetText)],
    artifact_files: {
      stdout: `${artifactPrefix}/stdout.log`,
      stderr: `${artifactPrefix}/stderr.log`,
      environment: `${artifactPrefix}/environment.json`,
      phases: `${artifactPrefix}/phases.json`,
      reset: `${artifactPrefix}/reset.json`,
    },
    duration_ms: Date.now() - started,
    limits: environment.limits,
    sandbox,
    ...(sourceSnapshot ? { source_snapshot: sourceSnapshot } : {}),
    ...(imageId ? { image: { reference: options.image, id: imageId, repo_digests: imageDigests } } : {}),
    ...(runtimeCache ? {
      runtime_cache: {
        spec_version: runtimeCache.manifest.spec_version,
        root_hash: runtimeCache.manifest.root_hash,
        files_hash: runtimeCache.manifest.files_hash,
        prepare_command_hash: runtimeCache.manifest.prepare_command_hash,
        file_count: runtimeCache.manifest.file_count,
        total_bytes: runtimeCache.manifest.total_bytes,
        verified_unchanged: runtimeUnchanged,
      },
    } : {}),
    phase_results: phases,
    expected: options.expected ?? (options.faultCommand
      ? '基线测试通过，seeded fault 运行被同一测试以非零退出识别'
      : '固定源码命令在禁网、无 secret、资源受限容器中成功'),
    actual,
    test_classes: succeeded && options.testClasses ? options.testClasses : defaultTestClasses(succeeded),
    ...(options.faultCommand && options.faultRef ? {
      fault_detection: { baseline_passed: baselinePassed, fault_failed: faultFailed, fault_ref: options.faultRef },
    } : {}),
    reset: { succeeded: resetSucceeded, log_hash: sha256(JSON.stringify(resetEvidence)) },
  };
  result.content_hash = computeContentHash(result);
  await upsertExecutionResult(path.join(rootDir, run.origin.executionResults), result);
  return { result, stdout, stderr };
}
