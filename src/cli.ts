#!/usr/bin/env node
/**
 * PTKG Authoring Kit CLI。
 *
 * 定位（来自 11 号方案第 6 节）：CLI 不做智能推理，只提供确定性。
 * 无论 bundle 由哪个模型生成，同一份输入必须得到同一份 findings。
 *
 * 子命令：
 *   ptkg init <dir>              生成 bundle 骨架
 *   ptkg validate <dir>          跑全部稳定规则
 *   ptkg lint <dir>              只报 blocker，用于 CI 快速门禁
 *   ptkg diff <old> <new>        两版之间的五类 diff
 *   ptkg report <dir>            生成 PTKG Generation Report
 *   ptkg pack <dir> -o <file>    打包成单文件供网页上传
 *   ptkg rules                   列出规则码与含义
 *   ptkg authoring-init <dir>    生成七类作者链契约骨架
 *   ptkg authoring-validate <dir> 校验作者链与 PTKG projection
 *   ptkg authoring-rules         列出 candidate 规则
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { validateBundle } from './validate.ts';
import { formatGenerationReport, formatJson, formatText } from './reporter.ts';
import { diffBundles, formatDiffText } from './diff.ts';
import { loadBundle } from './loader.ts';
import { RULE_CODES } from './types.ts';
import type { RuleCode } from './types.ts';
import {
  AUTHORING_RULE_CODES,
  AUTHORING_RULE_DESCRIPTIONS,
  type AuthoringProfile,
} from './authoring/types.ts';
import { formatAuthoringResult, validateAuthoringRun } from './authoring/validate.ts';
import { inspectAuthoringHashes, writeAuthoringHashes } from './authoring/hash.ts';
import { verifyAuthoringWorkspace } from './authoring/workspace.ts';
import { analyzeAuthoringImpact } from './authoring/impact.ts';
import { executeAuthoringSlice, prepareAuthoringRuntime } from './authoring/execute.ts';
import { initializeProjectWorkspace } from './project/workspace.ts';
import { authorProject } from './project/author.ts';
import { getProjectStatus } from './project/status.ts';
import type { AgentKind } from './project/types.ts';
import { splitAuthoringTasks } from './project/task-split.ts';
import { mergeAuthoringShards } from './project/author-merge.ts';
import { sealAuthoringShard } from './project/shard-seal.ts';
import { PARALLEL_CHECKPOINTS, type ParallelCheckpointId } from './project/shard-types.ts';
import { recoverWorkspaceLease } from './io/atomic.ts';
import { compileCourse } from './course/compiler.ts';
import { formatCourseValidation, validateCoursePackage } from './course/validate.ts';
import { signCoursePackage } from './course/sign.ts';
import { packCoursePackage } from './course/pack.ts';
import type { CourseProfile } from './course/types.ts';

const USAGE = `OS Camp PTKG v0.4 — 项目牵引式课程作者与校验工具

用法：
  ptkg init <dir>                  生成 bundle 骨架（manifest + 四个空文件）
  ptkg validate <dir> [选项]        跑全部规则，输出人类可读报告
  ptkg lint <dir>                  只输出 blocker，适合 CI
  ptkg diff <旧dir> <新dir>         输出新增/修改/删除/失效/待决五类 diff
  ptkg report <dir>                输出 PTKG Generation Report（Markdown）
  ptkg pack <dir> -o <out.json>    打包成单文件 bundle
  ptkg rules                       列出全部稳定规则码
  ptkg authoring-init <dir>        生成作者链七类契约与 PTKG projection 骨架
  ptkg authoring-validate <dir>    校验作者链（默认 authoring profile）
  ptkg authoring-rules             列出全部 candidate 规则
  ptkg authoring-hash <dir>        校验或回写规范化 content hash
  ptkg authoring-verify-workspace <dir> 验证固定 Git tree、path 与 symbol
  ptkg authoring-impact <旧dir> <新dir> 生成增量影响索引与教师审核报告
  ptkg authoring-runtime-prepare <dir> --image <digest> --prepare-command <cmd> --out <cache-dir>
                                      在联网准备阶段填充 source/image 绑定的离线 runtime cache
  ptkg authoring-execute <dir> --slice <id> --image <digest> --run-command <cmd>
                                      在固定源码 worktree 与固定 digest 容器中执行切片
      [--fault-command <cmd> --fault-ref <id>] [--test-classes <csv>]
      [--cache-dir <dir>] [--runtime-cache <prepared-cache-dir>]
                                      可选重放 seeded fault 并声明实际覆盖的测试类别
  ptkg project-init <dir> --repo <url-or-path> [--goal <text>] [--doc <path-or-url>]...
                                      锁定项目源码并建立通用作者工作区
  ptkg author <dir> --agent codex|claude|manual [--shard <id>]
                                      执行全局 checkpoint 或隔离 Agent 分片
  ptkg task-split <dir> --agents <2..32> [--checkpoint <name>]
                                      按行为连通覆盖组或课程单元创建隔离分片
  ptkg author-merge <dir> [--write]   dry-run 或确定性合并 Agent 分片
  ptkg author-seal <dir> --shard <id> 封存一个已完成的 Agent 分片输出
  ptkg author-recover-lease <dir> --expected-token <token> --confirm-owner-stopped
                                      显式清除已过期且旧进程已停止的协调器锁
  ptkg status <dir>                   显示 checkpoint、未决项与下一步
  ptkg course-compile <workspace> --out <package-dir>
                                      编译确定性 os-camp-course@1 课程包
  ptkg course-validate <package-dir> --profile draft|release
                                      执行 COURSE001-012 质量门
  ptkg course-sign <package-dir> --key <pkcs8-key> --actor <teacher-id>
                                      使用 Ed25519 教师身份签署 release
  ptkg course-pack <package-dir> [--out <archive.tgz>]
                                      校验并生成确定性 tgz 归档

选项：
  --json                 以 JSON 输出（供网页/CI 消费）
  --only <码,码>          只跑指定规则，如 --only PTKG003,PTKG006
  --skip <码,码>          跳过指定规则
  --stale-after <天数>    来源过期阈值，默认 180
  --no-hints             不输出修复建议
  --max <条数>            每条规则最多显示几条，默认 10
  --profile <名称>        authoring / review / publishing
  --repo <URL或路径>      project-init 的 Git 仓库
  --goal <文本>           可选完整项目目标
  --doc <路径或URL>       可重复的项目文档
  --ref <commit/ref>      可选源码 ref；最终仍锁定 40 位 commit
  --agent <名称>          codex / claude / manual
  --agents <数量>         task-split 的并行 Agent 数，2..32
  --checkpoint <名称>     competency_evidence / course_assets
  --shard <ID>            只执行活动 task plan 中的一个隔离分片
  --expected-token <ID>   待恢复过期锁中显示的精确 token
  --confirm-owner-stopped 明确确认旧协调器进程已经停止
  --key <文件>            Ed25519 PKCS#8 私钥文件
  --actor <ID>            教师或发布责任人 ID
  --trust-store <文件>    ptkg-trust-store@1 外部可信公钥
  --fault-command <命令>  基线通过后注入 seeded fault 并运行判别测试
  --fault-ref <ID>        seeded fault 的稳定标识
                          判别命令须输出 PTKG_SEEDED_FAULT_DETECTED:<ID> 并非零退出
  --test-classes <CSV>    positive,negative,concurrency,regression
  --expected <文本>       本次执行的明确预期

退出码：
  0  无 blocker（可进入教师审核）
  1  存在 blocker
  2  用法错误或内部错误
`;

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
  multiFlags: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  const multiFlags = new Map<string, string[]>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    // -o <path> 简写
    if (arg === '-o') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error('选项 -o 需要一个输出路径。');
      }
      flags.set('out', value);
      i++;
      continue;
    }

    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const name = arg.slice(2);
    // 带值的选项
    if (['only', 'skip', 'stale-after', 'max', 'out', 'profile', 'cache-dir', 'runtime-cache', 'slice', 'image', 'run-command', 'prepare-command', 'fault-command', 'fault-ref', 'test-classes', 'expected', 'timeout-seconds', 'memory-mb', 'processes', 'repo', 'goal', 'doc', 'ref', 'agent', 'agents', 'checkpoint', 'shard', 'expected-token', 'key', 'actor', 'trust-store'].includes(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`选项 --${name} 需要一个值。`);
      }
      if (name === 'doc') {
        multiFlags.set(name, [...(multiFlags.get(name) ?? []), value]);
      } else {
        flags.set(name, value);
      }
      i++;
    } else {
      flags.set(name, true);
    }
  }

  return {
    command: positional[0] ?? '',
    positional: positional.slice(1).filter((p) => p !== '-o'),
    flags,
    multiFlags,
  };
}

/** 解析 --only/--skip 里的规则码，无效码直接报错而不是静默忽略。 */
function parseRuleCodes(value: string | boolean | undefined, label: string): RuleCode[] | undefined {
  if (typeof value !== 'string') return undefined;
  const codes = value
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c !== '');

  const invalid = codes.filter((c) => !(RULE_CODES as readonly string[]).includes(c));
  if (invalid.length > 0) {
    throw new Error(`--${label} 含无效规则码：${invalid.join(', ')}。用 \`ptkg rules\` 查看全部。`);
  }
  return codes as RuleCode[];
}

function parseNumber(value: string | boolean | undefined, label: string): number | undefined {
  if (typeof value !== 'string') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--${label} 需要一个非负数字，收到 \`${value}\`。`);
  }
  return n;
}

function parseTestClasses(value: string | boolean | undefined) {
  if (typeof value !== 'string') return undefined;
  const classes = value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const allowed = new Set(['positive', 'negative', 'concurrency', 'regression']);
  const invalid = classes.filter((item) => !allowed.has(item));
  if (invalid.length > 0) throw new Error(`--test-classes 含无效类别：${invalid.join(', ')}。`);
  const selected = new Set(classes);
  return {
    positive: selected.has('positive'),
    negative: selected.has('negative'),
    concurrency: selected.has('concurrency') ? true as const : 'not_applicable' as const,
    regression: selected.has('regression'),
  };
}

// ── init ──────────────────────────────────────────────────────────────

const MANIFEST_SKELETON = `# PTKG bundle manifest
# 由 \`ptkg init\` 生成。填完后跑 \`ptkg validate .\` 检查。
ptkg_version: "0.1"
bundle_id: "ptkg.changeme.project"
title: "待填写 项目课程图谱"
status: "draft"
language: "zh-CN"
created_at: "${new Date().toISOString()}"
curriculum_version: "0.1.0"

project_ref:
  repository_url: "https://github.com/OWNER/REPO"
  # 必须是固定 commit sha，不能填分支名。分支会漂移，学生会拿到与图不符的代码。
  git_ref: "REQUIRED_COMMIT_SHA"

generator:
  tool: "claude-code"
  authoring_kit_version: "0.1.1"

approval:
  status: "draft"
  approved_by: null

files:
  nodes: "nodes.jsonl"
  edges: "edges.jsonl"
  sources: "sources.jsonl"
`;

const NODES_SKELETON = `# 每行一个节点对象。类型见 \`ptkg rules\` 与 02 号方案第 3 节。
# 示例（删掉后写自己的）。完整项目是倒推锚点，课程默认止于 Project Readiness Gate：
# {"id":"project.example","type":"project","title":"示例项目","status":"candidate","mission":"以完整项目倒推进入项目阶段前所需的能力与实践","repository":{"url":"https://github.com/OWNER/REPO","ref":"REQUIRED_COMMIT_SHA"},"curriculum_scope":{"mode":"pre_project_readiness","entry":"填写学生起点","exit":"Project Readiness Gate：填写可观察的出口能力","readiness_criteria":["填写至少一条可验证标准"],"excluded_responsibilities":["真实项目分工与个人贡献评价","要求提交或合并上游 PR"]},"outcomes":["填写前置学习道路的交付结果"],"acceptance":{"functional":["填写功能准备度"],"compatibility":["填写兼容性准备度"],"concurrency":["填写并发准备度"],"quality":["填写质量准备度"]},"non_goals":["不实施或评价真实项目阶段贡献"]}
`;

const EDGES_SKELETON = `# 每行一条边。关系类型见 02 号方案第 4 节。
# {"id":"edge.001","from":"project.example","type":"DECOMPOSES_TO","to":"outcome.example","status":"candidate"}
`;

const SOURCES_SKELETON = `# 每行一个来源。trust_level：A=仓库固定commit/官方规范，B=官方项目页，C=第三方，D=推测。
# {"id":"src.example","type":"source","source_kind":"official_doc","title":"...","url":"https://...","retrieved_at":"2026-07-25","trust_level":"A"}
`;

async function cmdInit(dir: string): Promise<number> {
  if (!dir) throw new Error('init 需要一个目录参数：ptkg init <dir>');
  await mkdir(dir, { recursive: true });

  const files: [string, string][] = [
    ['manifest.yaml', MANIFEST_SKELETON],
    ['nodes.jsonl', NODES_SKELETON],
    ['edges.jsonl', EDGES_SKELETON],
    ['sources.jsonl', SOURCES_SKELETON],
  ];

  for (const [name, content] of files) {
    const full = path.join(dir, name);
    // 用 wx 标志：已存在就跳过，绝不覆盖教师已有的工作
    try {
      await writeFile(full, content, { flag: 'wx' });
      console.log(`  创建 ${name}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        console.log(`  跳过 ${name}（已存在，未覆盖）`);
      } else {
        throw err;
      }
    }
  }

  console.log(`\nbundle 骨架已就绪：${dir}`);
  console.log('下一步：填 manifest.yaml 的 project_ref.git_ref（固定 commit），然后写 nodes.jsonl。');
  return 0;
}

const AUTHORING_SOURCE_SKELETON = `spec_version: source-contract@0.1
id: source-contract.changeme
run_id: run.changeme.001
project_ref:
  repo: https://github.com/OWNER/REPO
  commit: REQUIRED_40_CHAR_COMMIT
status: unresolved
input_refs: []
claims: []
created_by: { actor_type: agent, actor_id: local-agent }
content_hash: REQUIRED_64_CHAR_CONTENT_HASH
created_at: ${new Date().toISOString()}
repository: https://github.com/OWNER/REPO
target: 填写完整项目目标
curriculum_boundary: pre_project_readiness
non_goals: [不规划真实项目分工, 不评价个人项目贡献]
environment: { build_system: 待核实, runner: 待核实 }
build: [待核实]
tests: [待核实]
unresolved_questions: [冻结 commit 与运行环境待确认]
checkout:
  expected_tree: REQUIRED_40_CHAR_TREE
  candidates:
    - repository: https://github.com/OWNER/REPO
      ref: REQUIRED_FETCH_REF
`;

const AUTHORING_COVERAGE_SKELETON = `spec_version: project-coverage@0.1
id: coverage.changeme
run_id: run.changeme.001
project_ref:
  repo: https://github.com/OWNER/REPO
  commit: REQUIRED_40_CHAR_COMMIT
status: unresolved
input_refs: [source-contract.changeme]
claims: []
created_by: { actor_type: agent, actor_id: local-agent }
content_hash: REQUIRED_64_CHAR_CONTENT_HASH
created_at: ${new Date().toISOString()}
release_level: author_preview
required_unit_ids: [coverage.changeme.full-project]
units:
  - id: coverage.changeme.full-project
    title: 待拆分的完整项目覆盖
    required: true
    critical: true
    status: unresolved
    source_refs: []
platform_family:
  id: platform.changeme
  shared_trunk_refs: []
reuse_links: []
`;

async function writeAuthoringFile(dir: string, relative: string, content: string): Promise<void> {
  const full = path.join(dir, relative);
  await mkdir(path.dirname(full), { recursive: true });
  try {
    await writeFile(full, content, { flag: 'wx' });
    console.log(`  创建 ${relative}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      console.log(`  跳过 ${relative}（已存在，未覆盖）`);
      return;
    }
    throw err;
  }
}

async function cmdAuthoringInit(dir: string): Promise<number> {
  if (!dir) throw new Error('authoring-init 需要一个目录参数。');
  await mkdir(dir, { recursive: true });
  const files: [string, string][] = [
    ['run-manifest.yaml', 'authoring_version: "0.1"\nrun_id: run.changeme.001\nprofile: authoring\nproject_ref:\n  repo: https://github.com/OWNER/REPO\n  commit: REQUIRED_40_CHAR_COMMIT\nreports_dir: reports\n'],
    ['01-source/source-contract.yaml', AUTHORING_SOURCE_SKELETON],
    ['02-facts/code-facts.jsonl', '# 每行一个 code-fact@0.1 对象。\n'],
    ['03-coverage/project-coverage.yaml', AUTHORING_COVERAGE_SKELETON],
    ['04-behaviors/behavior-chains.jsonl', '# 每行一个 behavior-chain@0.1 对象。\n'],
    ['05-slices/learning-slices.jsonl', '# 每行一个 learning-slice@0.1 对象。\n'],
    ['06-execution/execution-results.jsonl', '# 每行一个 execution-result@0.1 对象。\n'],
    ['08-governance/review-events.jsonl', '# 每行一个 review-event@0.1 对象。\n'],
    ['08-governance/exception-events.jsonl', '# 每行一个 approve_exception review-event@0.1 对象。\n'],
  ];
  for (const [relative, content] of files) await writeAuthoringFile(dir, relative, content);
  await mkdir(path.join(dir, 'reports'), { recursive: true });
  await cmdInit(path.join(dir, '07-projection'));
  console.log(`\n作者链骨架已就绪：${dir}`);
  console.log(`下一步：填七类契约，然后运行 \`ptkg authoring-validate ${dir}\`。`);
  return 0;
}

function parseProfile(value: string | boolean | undefined): AuthoringProfile {
  if (value === undefined) return 'authoring';
  if (typeof value !== 'string' || !['authoring', 'review', 'publishing'].includes(value)) {
    throw new Error('--profile 只接受 authoring / review / publishing。');
  }
  return value as AuthoringProfile;
}

function parseCourseProfile(value: string | boolean | undefined): CourseProfile {
  if (value === undefined) return 'draft';
  if (typeof value !== 'string' || !['draft', 'release'].includes(value)) {
    throw new Error('--profile 只接受 draft / release。');
  }
  return value as CourseProfile;
}

// ── 主流程 ────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const { command, positional, flags, multiFlags } = parseArgs(argv);
  const asJson = flags.get('json') === true;

  switch (command) {
    case 'project-init': {
      const dir = positional[0];
      const repository = flags.get('repo');
      if (!dir || typeof repository !== 'string') {
        throw new Error('project-init 需要 <workspace> 和 --repo <url-or-path>。');
      }
      const result = await initializeProjectWorkspace(dir, {
        repository,
        goal: typeof flags.get('goal') === 'string' ? flags.get('goal') as string : undefined,
        documents: multiFlags.get('doc') ?? [],
        ref: typeof flags.get('ref') === 'string' ? flags.get('ref') as string : undefined,
        cacheDir: typeof flags.get('cache-dir') === 'string' ? flags.get('cache-dir') as string : undefined,
      });
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`项目工作区已初始化：${result.status.workspace}`);
        console.log(`固定 commit：${result.snapshot.projectRef.commit}`);
        console.log(`固定 tree：${result.snapshot.tree}`);
        console.log(`代码事实：${result.analyzerResults.reduce((sum, item) => sum + item.facts.length, 0)}`);
        console.log(`下一 checkpoint：${result.status.next_checkpoint ?? 'none'}`);
      }
      return 0;
    }

    case 'status': {
      const dir = positional[0];
      if (!dir) throw new Error('status 需要一个项目工作区。');
      const status = await getProjectStatus(dir);
      if (asJson) console.log(JSON.stringify(status, null, 2));
      else {
        console.log(`PTKG 项目工作区：${status.workspace}`);
        console.log(`源码锁定：${status.source_locked ? 'yes' : 'no'}`);
        for (const checkpoint of status.checkpoints) {
          console.log(`  ${checkpoint.status.padEnd(8)} ${checkpoint.id} · ${checkpoint.evidence.join('，')}`);
          for (const blocker of checkpoint.blockers) console.log(`    blocker: ${blocker}`);
        }
        if (status.parallel_authoring) {
          console.log(
            `并行作者：${status.parallel_authoring.checkpoint} · ${status.parallel_authoring.merged ? '已合并' : `${status.parallel_authoring.ready_shards}/${status.parallel_authoring.shard_count} shards ready`}`,
          );
          if (status.parallel_authoring.pending_shard_ids.length > 0) {
            console.log(`  待完成：${status.parallel_authoring.pending_shard_ids.join(', ')}`);
          }
          if (status.parallel_authoring.invalid_shard_ids.length > 0) {
            console.log(`  已失效：${status.parallel_authoring.invalid_shard_ids.join(', ')}`);
          }
        }
        console.log(`下一步：${status.next_command ?? '全部 checkpoint 已完成'}`);
      }
      return status.source_locked ? 0 : 1;
    }

    case 'author': {
      const dir = positional[0];
      const rawAgent = flags.get('agent');
      if (!dir || typeof rawAgent !== 'string' || !['codex', 'claude', 'manual'].includes(rawAgent)) {
        throw new Error('author 需要 <workspace> 和 --agent codex|claude|manual。');
      }
      const rawShard = flags.get('shard');
      const result = await authorProject(dir, rawAgent as AgentKind, {
        shardId: typeof rawShard === 'string' ? rawShard : undefined,
      });
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else if (!result.checkpoint) console.log('全部 checkpoint 已完成。');
      else {
        console.log(`checkpoint：${result.checkpoint}`);
        console.log(`指令：${result.instruction_path}`);
        if (result.log_path) console.log(`日志：${result.log_path}`);
        console.log(`退出码：${result.exit_code}`);
      }
      return result.exit_code === 0 ? 0 : 1;
    }

    case 'task-split': {
      const dir = positional[0];
      const rawAgents = flags.get('agents');
      const rawCheckpoint = flags.get('checkpoint');
      if (!dir || typeof rawAgents !== 'string') {
        throw new Error('task-split 需要 <workspace> 和 --agents <2..32>。');
      }
      const agents = Number(rawAgents);
      if (!Number.isInteger(agents)) throw new Error('--agents 必须是 2..32 的整数。');
      let checkpoint: ParallelCheckpointId | undefined;
      if (rawCheckpoint !== undefined) {
        if (
          typeof rawCheckpoint !== 'string'
          || !(PARALLEL_CHECKPOINTS as readonly string[]).includes(rawCheckpoint)
        ) {
          throw new Error('--checkpoint 只接受 competency_evidence / course_assets。');
        }
        checkpoint = rawCheckpoint as ParallelCheckpointId;
      }
      const result = await splitAuthoringTasks(dir, { agents, checkpoint });
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`checkpoint：${result.checkpoint}`);
        console.log(`input hash：${result.input_hash}`);
        console.log(`活动任务清单：${result.plan_path}`);
        for (const shard of result.shards) {
          console.log(`  ${shard.shard_id} · ${shard.scope_kind}: ${shard.scope_ids.join(', ')}`);
          console.log(`    ${shard.instruction_path}`);
        }
        console.log('下一步：让每个 Agent 只完成自己的 instruction，然后运行 author-merge dry-run。');
      }
      return 0;
    }

    case 'author-merge': {
      const dir = positional[0];
      if (!dir) throw new Error('author-merge 需要 <workspace>。');
      const report = await mergeAuthoringShards(dir, { write: flags.get('write') === true });
      if (asJson) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`模式：${report.dry_run ? 'dry-run' : 'write'}`);
        console.log(`分片：${report.shard_ids.length}`);
        console.log(
          `accepted=${report.summary.accepted} duplicate=${report.summary.duplicate} conflict=${report.summary.conflict} stale=${report.summary.stale} rejected=${report.summary.rejected}`,
        );
        for (const item of report.items.filter((entry) => ['conflict', 'stale', 'rejected'].includes(entry.disposition))) {
          console.log(`  ${item.disposition} ${item.shard_id} ${item.path}${item.object_id ? `#${item.object_id}` : ''} · ${item.reason}`);
        }
        console.log(report.applied ? `已写入：${report.written_paths.join(', ')}` : 'canonical workspace 未修改。');
      }
      return report.summary.conflict + report.summary.stale + report.summary.rejected === 0 ? 0 : 1;
    }

    case 'author-seal': {
      const dir = positional[0];
      const rawShard = flags.get('shard');
      if (!dir || typeof rawShard !== 'string') throw new Error('author-seal 需要 <workspace> 和 --shard <id>。');
      const seal = await sealAuthoringShard(dir, rawShard);
      if (asJson) console.log(JSON.stringify(seal, null, 2));
      else console.log(`已封存 ${seal.shard_id}：${seal.files.length} 个文件，output hash ${seal.output_hash}`);
      return 0;
    }

    case 'author-recover-lease': {
      const dir = positional[0];
      const expectedToken = flags.get('expected-token');
      const confirmed = flags.get('confirm-owner-stopped') === true;
      if (!dir || typeof expectedToken !== 'string' || !confirmed) {
        throw new Error('author-recover-lease 需要 <workspace>、--expected-token <token> 和 --confirm-owner-stopped。');
      }
      const lock = path.join(path.resolve(dir), '.ptkg', 'locks', 'authoring-coordinator.lock');
      await recoverWorkspaceLease(lock, { expectedToken, confirmOwnerStopped: true });
      if (asJson) console.log(JSON.stringify({ recovered: true, lock }, null, 2));
      else console.log(`已显式清除过期协调器锁：${lock}`);
      return 0;
    }

    case 'course-compile': {
      const workspace = positional[0];
      const output = flags.get('out');
      if (!workspace || typeof output !== 'string') {
        throw new Error('course-compile 需要 <workspace> 和 --out <package-dir>。');
      }
      const compiled = await compileCourse(workspace, output);
      const validation = await validateCoursePackage(compiled.package_dir, 'draft');
      if (asJson) console.log(JSON.stringify({ compiled, validation }, null, 2));
      else {
        console.log(`课程包已编译：${compiled.package_dir}`);
        console.log(`package root：${compiled.checksums.root_hash}`);
        console.log(formatCourseValidation(validation));
      }
      return validation.passed ? 0 : 1;
    }

    case 'course-validate': {
      const directory = positional[0];
      if (!directory) throw new Error('course-validate 需要 <package-dir>。');
      const profile = parseCourseProfile(flags.get('profile'));
      const trustStore = flags.get('trust-store');
      const result = await validateCoursePackage(directory, profile, {
        trustStore: typeof trustStore === 'string' ? trustStore : undefined,
      });
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else console.log(formatCourseValidation(result));
      return result.passed ? 0 : 1;
    }

    case 'course-sign': {
      const directory = positional[0];
      const key = flags.get('key');
      const actor = flags.get('actor');
      if (!directory || typeof key !== 'string' || typeof actor !== 'string') {
        throw new Error('course-sign 需要 <package-dir>、--key <pkcs8-key> 和 --actor <teacher-id>。');
      }
      const result = await signCoursePackage(directory, key, actor);
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`课程包已签名：${result.package_dir}`);
        console.log(`actor：${result.attestation.actor}`);
        console.log(`key：${result.attestation.key_fingerprint}`);
        console.log(`package root：${result.attestation.root_hash}`);
      }
      return 0;
    }

    case 'course-pack': {
      const directory = positional[0];
      if (!directory) throw new Error('course-pack 需要 <package-dir>。');
      const trustStore = flags.get('trust-store');
      const output = flags.get('out');
      const result = await packCoursePackage(
        directory,
        typeof output === 'string' ? output : undefined,
        typeof trustStore === 'string' ? trustStore : undefined,
      );
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`课程归档：${result.archive}`);
        console.log(`bytes：${result.bytes}`);
        console.log(`package root：${result.root_hash}`);
      }
      return 0;
    }

    case 'init':
      return cmdInit(positional[0] ?? '');

    case 'authoring-init':
      return cmdAuthoringInit(positional[0] ?? '');

    case 'authoring-rules':
      if (asJson) {
        console.log(JSON.stringify(AUTHORING_RULE_DESCRIPTIONS, null, 2));
      } else {
        console.log('PTKG 作者链 candidate 规则（成熟前不占用 PTKG015+）：\n');
        for (const code of AUTHORING_RULE_CODES) {
          console.log(`  ${code}  ${AUTHORING_RULE_DESCRIPTIONS[code]}`);
        }
      }
      return 0;

    case 'authoring-hash': {
      const dir = positional[0];
      if (!dir) throw new Error('authoring-hash 需要一个作者运行目录。');
      const entries = flags.get('write') === true
        ? await writeAuthoringHashes(dir)
        : await inspectAuthoringHashes(dir);
      if (asJson) {
        console.log(JSON.stringify(entries, null, 2));
      } else {
        for (const entry of entries) {
          console.log(`${entry.matches ? 'OK' : 'MISMATCH'} ${entry.id} ${entry.computed}`);
        }
      }
      return entries.every((entry) => entry.matches) ? 0 : 1;
    }

    case 'authoring-verify-workspace': {
      const dir = positional[0];
      if (!dir) throw new Error('authoring-verify-workspace 需要一个作者运行目录。');
      const cacheDir = flags.get('cache-dir');
      const result = await verifyAuthoringWorkspace(
        dir,
        typeof cacheDir === 'string' ? cacheDir : undefined,
      );
      console.log(asJson ? JSON.stringify(result, null, 2) : [
        `固定 commit ${result.project_ref.commit}`,
        `tree ${result.tree}`,
        `来源 ${result.fetched_from.repository} ${result.fetched_from.ref}`,
        `锚点 ${result.anchors.filter((item) => item.status === 'verified').length}/${result.anchors.length} verified`,
      ].join('\n'));
      return result.anchors.every((item) => item.status === 'verified') ? 0 : 1;
    }

    case 'authoring-impact': {
      const [oldDir, newDir] = positional;
      if (!oldDir || !newDir) throw new Error('authoring-impact 需要两个作者运行目录：旧 dir 与新 dir。');
      const result = await analyzeAuthoringImpact(oldDir, newDir);
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`影响索引 → ${result.files.index}`);
        console.log(`影响报告 → ${result.files.report}`);
        console.log(`新增 ${result.report.added.length} · 修改 ${result.report.changed.length} · 失效 ${result.report.stale.length} · 继承 ${result.report.inherited.length}`);
        console.log(`待教师决定：锚点候选映射 ${result.report.teacher_decisions.anchor_mappings.length} 条`);
      }
      return 0;
    }

    case 'authoring-runtime-prepare': {
      const dir = positional[0];
      const image = flags.get('image');
      const command = flags.get('prepare-command');
      const output = flags.get('out');
      if (!dir || typeof image !== 'string' || typeof command !== 'string' || typeof output !== 'string') {
        throw new Error('authoring-runtime-prepare 需要 <dir>、--image、--prepare-command 和 --out。');
      }
      const result = await prepareAuthoringRuntime(dir, {
        image,
        command,
        outDir: output,
        timeoutSeconds: parseNumber(flags.get('timeout-seconds'), 'timeout-seconds'),
        memoryMb: parseNumber(flags.get('memory-mb'), 'memory-mb'),
        processes: parseNumber(flags.get('processes'), 'processes'),
        cacheDir: typeof flags.get('cache-dir') === 'string' ? flags.get('cache-dir') as string : undefined,
      });
      console.log(asJson ? JSON.stringify(result, null, 2) : [
        `runtime cache：${result.status}`,
        `目录：${result.cache_dir}`,
        `root hash：${result.root_hash ?? 'unresolved'}`,
        `准备 stdout：${result.stdout_file}`,
        `准备 stderr：${result.stderr_file}`,
      ].join('\n'));
      return result.status === 'ready' ? 0 : 1;
    }

    case 'authoring-execute': {
      const dir = positional[0];
      const sliceId = flags.get('slice');
      const image = flags.get('image');
      const runCommand = flags.get('run-command');
      if (!dir || typeof sliceId !== 'string' || typeof image !== 'string' || typeof runCommand !== 'string') {
        throw new Error('authoring-execute 需要 <dir>、--slice、--image 和 --run-command。');
      }
      const result = await executeAuthoringSlice(dir, {
        sliceId,
        image,
        command: runCommand,
        faultCommand: typeof flags.get('fault-command') === 'string' ? flags.get('fault-command') as string : undefined,
        faultRef: typeof flags.get('fault-ref') === 'string' ? flags.get('fault-ref') as string : undefined,
        expected: typeof flags.get('expected') === 'string' ? flags.get('expected') as string : undefined,
        testClasses: parseTestClasses(flags.get('test-classes')),
        timeoutSeconds: parseNumber(flags.get('timeout-seconds'), 'timeout-seconds'),
        memoryMb: parseNumber(flags.get('memory-mb'), 'memory-mb'),
        processes: parseNumber(flags.get('processes'), 'processes'),
        cacheDir: typeof flags.get('cache-dir') === 'string' ? flags.get('cache-dir') as string : undefined,
        runtimeCache: typeof flags.get('runtime-cache') === 'string' ? flags.get('runtime-cache') as string : undefined,
      });
      console.log(asJson ? JSON.stringify(result.result, null, 2) : `${result.result.id} ${result.result.result_status} → ${dir}`);
      return result.result.result_status === 'succeeded' ? 0 : 1;
    }

    case 'authoring-validate': {
      const dir = positional[0];
      if (!dir) throw new Error('authoring-validate 需要一个作者运行目录。');
      const result = await validateAuthoringRun(dir, parseProfile(flags.get('profile')));
      console.log(asJson ? JSON.stringify(result, null, 2) : formatAuthoringResult(result));
      return result.passed ? 0 : 1;
    }

    case 'rules': {
      const { RULE_DESCRIPTIONS } = await import('./reporter.ts');
      if (asJson) {
        console.log(JSON.stringify(RULE_DESCRIPTIONS, null, 2));
        return 0;
      }
      console.log('PTKG 校验规则码（编号含义一经发布不得改变，只能追加）：\n');
      for (const code of RULE_CODES) {
        console.log(`  ${code}  ${RULE_DESCRIPTIONS[code] ?? ''}`);
      }
      return 0;
    }

    case 'validate':
    case 'lint': {
      const dir = positional[0];
      if (!dir) throw new Error(`${command} 需要一个 bundle 目录参数。`);

      const result = await validateBundle(dir, {
        only: parseRuleCodes(flags.get('only'), 'only'),
        skip: parseRuleCodes(flags.get('skip'), 'skip'),
        staleAfterDays: parseNumber(flags.get('stale-after'), 'stale-after'),
      });

      if (asJson) {
        console.log(formatJson(result));
      } else {
        console.log(
          formatText(result, {
            blockersOnly: command === 'lint',
            hints: flags.get('no-hints') !== true,
            maxPerCode: parseNumber(flags.get('max'), 'max') ?? 10,
          }),
        );
      }
      return result.passed ? 0 : 1;
    }

    case 'report': {
      const dir = positional[0];
      if (!dir) throw new Error('report 需要一个 bundle 目录参数。');
      const result = await validateBundle(dir);
      console.log(formatGenerationReport(result));
      return result.passed ? 0 : 1;
    }

    case 'diff': {
      const [oldDir, newDir] = positional;
      if (!oldDir || !newDir) throw new Error('diff 需要两个目录：ptkg diff <旧> <新>');

      const [oldLoaded, newLoaded] = await Promise.all([loadBundle(oldDir), loadBundle(newDir)]);
      if (!oldLoaded.bundle || !newLoaded.bundle) {
        console.error('至少一侧 bundle 无法载入，先用 `ptkg validate` 检查。');
        return 2;
      }

      const d = diffBundles(oldLoaded.bundle, newLoaded.bundle);
      console.log(asJson ? JSON.stringify(d, null, 2) : formatDiffText(d));
      return 0;
    }

    case 'pack': {
      const dir = positional[0];
      if (!dir) throw new Error('pack 需要一个 bundle 目录参数。');

      const out = flags.get('o') ?? flags.get('out');
      if (typeof out !== 'string') {
        throw new Error('pack 需要输出路径：ptkg pack <dir> -o <out.json>');
      }

      // 打包前必须过 blocker：不让不合法的 bundle 流到网页端
      const result = await validateBundle(dir);
      if (!result.passed) {
        console.error(`存在 ${result.summary.blocker} 个 blocker，拒绝打包。先跑 \`ptkg validate ${dir}\`。`);
        return 1;
      }
      if (!result.bundle) return 2;

      const packed = {
        ptkg_version: result.bundle.manifest.ptkg_version,
        packed_at: new Date().toISOString(),
        manifest: result.bundle.manifest,
        nodes: result.bundle.nodes,
        edges: result.bundle.edges,
        sources: result.bundle.sources,
        validation: {
          passed: result.passed,
          summary: result.summary,
          findings: result.findings,
        },
      };

      await writeFile(out, JSON.stringify(packed, null, 2), 'utf8');
      const { nodes, edges, sources } = result.summary.counts;
      console.log(`已打包 → ${out}`);
      console.log(`  ${nodes} 节点 / ${edges} 边 / ${sources} 来源`);
      if (result.summary.review > 0) {
        console.log(`  注意：${result.summary.review} 条 review 项需教师在网页端处理。`);
      }
      return 0;
    }

    default:
      console.error(`未知子命令：\`${command}\`\n`);
      console.log(USAGE);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`错误：${err instanceof Error ? err.message : String(err)}`);
    if (process.env.PTKG_DEBUG === '1' && err instanceof Error) {
      console.error(err.stack);
    }
    process.exit(2);
  });
