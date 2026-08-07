import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { getProjectStatus } from './status.ts';
import type { AgentKind, AuthorResult, CheckpointId, ProjectInput } from './types.ts';
import YAML from 'yaml';

const execFileAsync = promisify(execFile);

const CHECKPOINT_TASKS: Record<CheckpointId, string> = {
  project_contract: [
    '检查仓库是否包含多个合理的完整项目目标。',
    '若目标明确，更新 project-input.yaml 的 goal/status/unresolved_questions，并同步 01-source/source-contract.yaml。',
    '若目标不明确，列出候选项目合同和最少量待教师确认问题；不得擅自选择。',
    '课程范围必须保持 pre_project_readiness。',
  ].join('\n'),
  code_facts: [
    '读取固定 commit 的真实源码，完善 02-facts/code-facts.jsonl。',
    '只写已读取的文件和声明；调用引用不能冒充声明位置。',
    '运行 authoring-hash --write 和 authoring-verify-workspace，未验证事实标 unresolved。',
  ].join('\n'),
  project_graph: [
    '以完整项目为 L0，自顶向下生成 L1 系统成果域和 L2 工作包。',
    'L1/L2 只是课程倒推锚点，不给学生分配真实贡献任务。',
    '更新 03-coverage 和 07-projection，并保持 PTKG001-014 可校验。',
  ].join('\n'),
  competency_evidence: [
    '从 L2 推导可观察的 L3 能力、直接证据、L4 完整实践和 L5 知识前置。',
    '实践应使用固定源码或高保真 fixture，并包含正例、负例、并发或回归适用性。',
    '更新 behaviors、slices 和 projection；不得把阅读或 AI 自评写成 mastery。',
  ].join('\n'),
  course_assets: [
    '在 09-course 生成 blueprint、units、questions、practices、gates 和 cards。',
    '每个必修单元至少一张知识卡、一个实践、两道 diagnostic、两道 checkpoint 题。',
    '所有对象保持 candidate/unresolved，并引用 PTKG 节点、来源和项目。',
  ].join('\n'),
  reuse_review: [
    '匹配 canonical knowledge；只有 ID 和语义完全一致时声明 exact reuse。',
    '把相似、扩展、冲突、高风险和高影响前置边写入 08-governance/review-queues.json。',
    '不得代表教师 accept、publish 或生成可信签名。',
  ].join('\n'),
};

async function loadInput(root: string): Promise<ProjectInput> {
  return YAML.parse(await readFile(path.join(root, 'project-input.yaml'), 'utf8')) as ProjectInput;
}

export async function buildCheckpointInstruction(workspace: string, checkpoint: CheckpointId): Promise<string> {
  const root = path.resolve(workspace);
  const input = await loadInput(root);
  return `# PTKG checkpoint: ${checkpoint}

你正在教师本地工作区中，把一个真实系统项目拆成 Project Readiness Gate 之前的课程候选。

## 固定输入

- repository: ${input.repository.locator}
- commit: ${input.repository.commit}
- tree: ${input.repository.tree}
- source root: 见 .ptkg/source.json
- goal: ${input.goal ?? '(unresolved)'}
- curriculum boundary: pre_project_readiness

## 当前任务

${CHECKPOINT_TASKS[checkpoint]}

## 不可绕过的约束

1. 只使用固定 commit；不得静默移动到分支最新版本。
2. 没读过的源码不能写成仓库事实；不能定位的内容标 unresolved。
3. AI 只能产生 candidate/unresolved，不得 approve、publish 或签名。
4. 通用知识使用 kc. canonical ID，项目差异使用 binding。
5. 完整项目是拆解根，但课程不规划项目分工、个人贡献或真实 PR。
6. 私有文档正文不得进入 07-projection、09-course 的公开内容或日志。
7. 修改完成后运行 npm 工具对应的 hash、workspace 和 authoring 校验；保留 findings 给教师。

只处理这个 checkpoint。不要提前生成后续阶段的最终内容。`;
}

async function executeAgent(root: string, agent: Exclude<AgentKind, 'manual'>, prompt: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const command = agent === 'codex' ? 'codex' : 'claude';
  const args = agent === 'codex'
    ? ['exec', '--ephemeral', '--skip-git-repo-check', '-C', root, '-s', 'workspace-write', prompt]
    : ['-p', '--permission-mode', 'acceptEdits', '--no-session-persistence', prompt];
  try {
    const result = await execFileAsync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failed.code === 'number' ? failed.code : 2,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? failed.message,
    };
  }
}

export async function authorProject(workspace: string, agent: AgentKind): Promise<AuthorResult> {
  const root = path.resolve(workspace);
  const before = await getProjectStatus(root);
  const checkpoint = before.next_checkpoint;
  if (!checkpoint) {
    return { agent, checkpoint: null, instruction_path: null, log_path: null, exit_code: 0, status: before };
  }
  const instruction = await buildCheckpointInstruction(root, checkpoint);
  const instructionsDir = path.join(root, '.ptkg', 'instructions');
  const logsDir = path.join(root, '.ptkg', 'logs');
  await Promise.all([mkdir(instructionsDir, { recursive: true }), mkdir(logsDir, { recursive: true })]);
  const instructionPath = path.join(instructionsDir, `${checkpoint}.md`);
  await writeFile(instructionPath, `${instruction}\n`, 'utf8');
  if (agent === 'manual') {
    const status = await getProjectStatus(root);
    await writeFile(path.join(root, '.ptkg', 'state.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8');
    return { agent, checkpoint, instruction_path: instructionPath, log_path: null, exit_code: 0, status };
  }
  const execution = await executeAgent(root, agent, instruction);
  const logPath = path.join(logsDir, `${checkpoint}.${agent}.log`);
  await writeFile(
    logPath,
    `agent=${agent}\ncheckpoint=${checkpoint}\nexit_code=${execution.exitCode}\n\n[stdout]\n${execution.stdout}\n\n[stderr]\n${execution.stderr}\n`,
    'utf8',
  );
  const status = await getProjectStatus(root);
  await writeFile(path.join(root, '.ptkg', 'state.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  return {
    agent,
    checkpoint,
    instruction_path: instructionPath,
    log_path: logPath,
    exit_code: execution.exitCode,
    status,
  };
}
