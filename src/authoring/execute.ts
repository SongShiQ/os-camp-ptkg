import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadAuthoringRun } from './loader.ts';
import { computeContentHash } from './hash.ts';
import type { AuthoringObject } from './types.ts';

const execFileAsync = promisify(execFile);
const IMAGE_DIGEST = /^[^@\s]+@sha256:[0-9a-f]{64}$/;

export interface ExecutionOptions {
  sliceId: string;
  image: string;
  command: string;
  timeoutSeconds?: number;
  memoryMb?: number;
  processes?: number;
}

export interface ExecutionRunResult {
  result: AuthoringObject;
  stdout: string;
  stderr: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function executionId(runId: string, sliceId: string): string {
  const digest = sha256(`${runId}\u0000${sliceId}`).slice(0, 16);
  return `exec.worker.${digest}`;
}

function asExitCode(error: unknown): number {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'number') return (error as { code: number }).code;
  return -1;
}

/**
 * Run one slice in a disposable Docker container. The image must be pinned by
 * digest; failure to reach Docker is recorded as failed/unresolved evidence.
 */
export async function executeAuthoringSlice(runDir: string, options: ExecutionOptions): Promise<ExecutionRunResult> {
  if (!IMAGE_DIGEST.test(options.image)) throw new Error('--image 必须是 name@sha256:<64位 digest>，禁止浮动 tag。');
  const loaded = await loadAuthoringRun(runDir);
  if (!loaded.run) throw new Error(`无法载入作者运行：${loaded.findings.map((item) => item.message).join('；')}`);
  const run = loaded.run;
  const slice = run.learningSlices.find((item) => item.id === options.sliceId);
  if (!slice) throw new Error(`找不到 learning-slice：${options.sliceId}`);
  const timeoutSeconds = options.timeoutSeconds ?? 600;
  const memoryMb = options.memoryMb ?? 4096;
  const processes = options.processes ?? 128;
  if (![timeoutSeconds, memoryMb, processes].every((value) => Number.isInteger(value) && value > 0)) throw new Error('资源限制必须是正整数。');
  const commands = [
    'docker', 'run', '--rm', '--network', 'none', '--pull', 'never',
    '--memory', `${memoryMb}m`, '--pids-limit', String(processes),
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    options.image, 'sh', '-lc', options.command,
  ];
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let resultStatus: 'succeeded' | 'failed' | 'inconclusive' = 'succeeded';
  try {
    const output = await execFileAsync(commands[0] as string, commands.slice(1), {
      cwd: runDir,
      timeout: timeoutSeconds * 1000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    stdout = output.stdout;
    stderr = output.stderr;
  } catch (error) {
    resultStatus = 'failed';
    exitCode = asExitCode(error);
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    stdout = failure.stdout ?? '';
    stderr = failure.stderr ?? failure.message ?? String(error);
  }
  const log = `${stdout}\n${stderr}`;
  const succeeded = resultStatus === 'succeeded';
  const result: AuthoringObject = {
    spec_version: 'execution-result@0.1',
    id: executionId(run.manifest.run_id, options.sliceId),
    run_id: run.manifest.run_id,
    project_ref: run.sourceContract.project_ref,
    status: succeeded ? 'candidate' : 'unresolved',
    input_refs: [options.sliceId],
    claims: [{
      id: `claim.${executionId(run.manifest.run_id, options.sliceId)}`,
      statement: succeeded ? `Docker 固定 digest 执行命令成功：${options.command}` : `Docker 执行未完成：${stderr.slice(0, 300)}`,
      epistemic_status: succeeded ? 'verified_fact' : 'unresolved',
      source_refs: [],
      anchor_refs: [],
      method: 'test',
      ...(succeeded ? { verified_at: new Date().toISOString() } : {}),
      validity: { commit_bound: true, invalidates_on: ['environment_change', 'test_change'] },
    }],
    created_by: { actor_type: 'tool', actor_id: 'isolated-worker' },
    content_hash: '',
    created_at: new Date().toISOString(),
    slice_ref: options.sliceId,
    result_status: resultStatus,
    environment_hash: sha256(JSON.stringify({ image: options.image, network: 'none', filesystem: 'read_only' })),
    toolchain_hash: sha256(JSON.stringify({ docker: 'pinned-digest', command: options.command })),
    commands: [commands.join(' ')],
    exit_code: exitCode,
    artifact_hashes: [sha256(log)],
    duration_ms: Date.now() - started,
    limits: { timeout_seconds: timeoutSeconds, memory_mb: memoryMb, processes },
    sandbox: { network: 'disabled', filesystem: 'read_only', secrets: 'none', resettable: true, push_allowed: false },
    expected: '命令在固定 digest、禁网和无 secret 容器中完成',
    actual: succeeded ? stdout.trim().slice(0, 1000) || '命令成功但无标准输出' : `执行失败：${stderr.trim().slice(0, 1000) || '无错误输出'}`,
    test_classes: { positive: succeeded, negative: false, concurrency: 'not_applicable', regression: false },
    reset: { succeeded: true, log_hash: sha256('docker --rm disposable container') },
  };
  result.content_hash = computeContentHash(result);
  await appendFile(path.join(runDir, run.origin.executionResults), `${JSON.stringify(result)}\n`, 'utf8');
  return { result, stdout, stderr };
}
