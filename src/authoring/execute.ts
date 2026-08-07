import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { computeContentHash } from './hash.ts';
import { loadAuthoringRun } from './loader.ts';
import type { AuthoringObject, AuthoringRun } from './types.ts';
import { verifyAuthoringWorkspace } from './workspace.ts';

const execFileAsync = promisify(execFile);
const IMAGE_DIGEST = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;

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
}

export interface ExecutionRunResult {
  result: AuthoringObject;
  stdout: string;
  stderr: string;
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

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function executionId(runId: string, sliceId: string): string {
  const digest = sha256(`${runId}\u0000${sliceId}`).slice(0, 16);
  return `exec.worker.${digest}`;
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

async function git(args: string[], cwd?: string): Promise<string> {
  const output = await capture('git', args, { cwd, timeoutMs: 120_000 });
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

async function createWorktree(snapshot: VerifiedSnapshot, commit: string): Promise<DisposableWorktree> {
  const root = await mkdtemp(path.join(tmpdir(), 'ptkg-worker-'));
  const source = path.join(root, 'source');
  let registered = false;
  try {
    await git([`--git-dir=${snapshot.cacheRepo}`, 'worktree', 'add', '--detach', source, commit]);
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
      await capture('git', [`--git-dir=${snapshot.cacheRepo}`, 'worktree', 'remove', '--force', source], { timeoutMs: 120_000 });
      await capture('git', [`--git-dir=${snapshot.cacheRepo}`, 'worktree', 'prune'], { timeoutMs: 120_000 });
    }
    await rm(root, { recursive: true, force: true });
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
  const removal = await capture(
    'git',
    [`--git-dir=${worktree.cacheRepo}`, 'worktree', 'remove', '--force', worktree.source],
    { timeoutMs: 120_000 },
  );
  messages.push(removal.exitCode === 0 ? 'git worktree registration removed' : `git worktree remove failed: ${removal.stderr}`);
  const prune = await capture('git', [`--git-dir=${worktree.cacheRepo}`, 'worktree', 'prune'], { timeoutMs: 120_000 });
  messages.push(prune.exitCode === 0 ? 'git worktree registry pruned' : `git worktree prune failed: ${prune.stderr}`);
  try {
    await rm(worktree.root, { recursive: true, force: true });
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

function dockerArgs(image: string, worktree: string, command: string, memoryMb: number, processes: number): string[] {
  const user = typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? ['--user', `${process.getuid()}:${process.getgid()}`]
    : [];
  return [
    'run', '--rm', '--network', 'none', '--pull', 'never',
    '--memory', `${memoryMb}m`, '--pids-limit', String(processes),
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...user,
    '--mount', `type=bind,src=${worktree},dst=/workspace`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456',
    '--workdir', '/workspace', '--entrypoint', 'sh',
    image, '-lc', command,
  ];
}

function displayedDockerCommand(args: string[]): string {
  const sanitized = args.map((value) => value.startsWith('type=bind,src=')
    ? 'type=bind,src=<disposable-worktree>,dst=/workspace'
    : value);
  return ['docker', ...sanitized].map((value) => /\s/.test(value) ? JSON.stringify(value) : value).join(' ');
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
  const loaded = await loadAuthoringRun(runDir);
  if (!loaded.run) throw new Error(`无法载入作者运行：${loaded.findings.map((item) => item.message).join('；')}`);
  const run = loaded.run;
  const slice = run.learningSlices.find((item) => item.id === options.sliceId);
  if (!slice) throw new Error(`找不到 learning-slice：${options.sliceId}`);
  const timeoutSeconds = options.timeoutSeconds ?? 600;
  const memoryMb = options.memoryMb ?? 4096;
  const processes = options.processes ?? 128;
  if (![timeoutSeconds, memoryMb, processes].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error('资源限制必须是正整数。');
  }

  const id = executionId(run.manifest.run_id, options.sliceId);
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

  try {
    const snapshot = await readVerifiedSnapshot(runDir, run, options.cacheDir);
    sourceSnapshot = { ...run.sourceContract.project_ref, tree: snapshot.tree };
    worktree = await createWorktree(snapshot, run.sourceContract.project_ref.commit);
    commands.push(displayedDockerCommand(['image', 'inspect', options.image, '--format', '{{json .}}']));
    const inspect = await capture('docker', ['image', 'inspect', options.image, '--format', '{{json .}}'], { timeoutMs: 60_000 });
    if (inspect.exitCode !== 0) throw new Error(inspect.stderr.trim() || `fixed image is unavailable: ${options.image}`);
    const image = JSON.parse(inspect.stdout) as { Id?: string; RepoDigests?: string[] };
    imageId = image.Id ?? null;
    imageDigests = Array.isArray(image.RepoDigests) ? image.RepoDigests : [];
    if (!imageId || !imageDigests.includes(options.image)) {
      throw new Error(`image inspect did not confirm requested digest: ${options.image}`);
    }

    const baselineArgs = dockerArgs(options.image, worktree.source, options.command, memoryMb, processes);
    commands.push(displayedDockerCommand(baselineArgs));
    baseline = await capture('docker', baselineArgs, { cwd: runDir, timeoutMs: timeoutSeconds * 1000 });
    stdoutParts.push(`[baseline]\n${baseline.stdout}`);
    stderrParts.push(`[baseline]\n${baseline.stderr}`);
    phases.push({ name: 'baseline', exit_code: baseline.exitCode, timed_out: baseline.timedOut, expected: 'exit 0' });

    if (baseline.exitCode === 0 && baseline.timedOut === false && options.faultCommand && options.faultRef) {
      beforeFaultReset = await resetWorktree(worktree, run.sourceContract.project_ref.commit, snapshot.tree);
      if (!beforeFaultReset.succeeded) throw new Error(`seeded fault 前无法恢复固定源码：${beforeFaultReset.log}`);
      const faultArgs = dockerArgs(options.image, worktree.source, options.faultCommand, memoryMb, processes);
      commands.push(displayedDockerCommand(faultArgs));
      fault = await capture('docker', faultArgs, { cwd: runDir, timeoutMs: timeoutSeconds * 1000 });
      stdoutParts.push(`[fault]\n${fault.stdout}`);
      stderrParts.push(`[fault]\n${fault.stderr}`);
      phases.push({ name: 'fault', exit_code: fault.exitCode, timed_out: fault.timedOut, expected: 'non-zero test exit' });
    }
  } catch (error) {
    setupError = (error as Error).message;
    stderrParts.push(`[setup]\n${setupError}`);
  }

  const cleanup = await removeWorktree(worktree);
  const resetEvidence = {
    ...(beforeFaultReset ? { before_fault: beforeFaultReset } : {}),
    cleanup,
  };
  const baselinePassed = baseline?.exitCode === 0 && baseline.timedOut === false;
  const faultFailed = fault !== null && fault.exitCode > 0 && fault.timedOut === false;
  const refs = inheritedClaimRefs(run, slice);
  const evidenceBound = refs.sourceRefs.length + refs.anchorRefs.length > 0;
  const resetSucceeded = cleanup.succeeded && (!beforeFaultReset || beforeFaultReset.succeeded);
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
  };
  const actual = setupError
    ? '执行环境未就绪；原始错误仅保存在本地 stderr artifact。'
    : succeeded
      ? options.faultCommand
        ? '基线通过，seeded fault 被测试以非零退出识别，worktree 已清理。'
        : '基线命令通过，worktree 已清理。'
      : `执行未满足预期：baseline=${baseline?.exitCode ?? 'not-run'} fault=${fault?.exitCode ?? 'not-run'} reset=${resetSucceeded}`;

  const artifactRoot = path.join(runDir, run.manifest.reports_dir, 'execution', id);
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
    toolchain_hash: sha256(JSON.stringify({ requested_image: options.image, image_id: imageId, commands })),
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
  await upsertExecutionResult(path.join(runDir, run.origin.executionResults), result);
  return { result, stdout, stderr };
}
