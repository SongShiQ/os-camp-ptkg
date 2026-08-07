/**
 * PTKG v0.1 核心类型契约。
 *
 * 与 `docs/plans/2026-07-25-StarryOS-cgroup-项目牵引式学习系统/02-项目到知识网络的拆分规范.md`
 * 第 3、4 节的节点/关系类型表一一对应；与 `08-模板与机器可读契约.md` 的模板字段对齐。
 *
 * 注意：本文件在 Node 原生类型剥离（type stripping）下运行，
 * 因此不使用 enum / namespace / 参数属性，只用 const 对象 + 联合类型。
 */

// ── 节点类型 ──────────────────────────────────────────────────────────

/** 六层主结构 L0–L5 对应的节点类型，加上不占主层级的辅助节点。 */
export const NODE_TYPES = [
  'project', // L0 Project Mission
  'outcome', // L1 System Outcome
  'work_package', // L2 Work Package
  'competency', // L3 Competency Claim
  'practice', // L4 Practice Task
  'knowledge', // L5 Knowledge Component
  'project_binding', // 项目绑定层（通用知识积木在具体项目上的落地）
  'repo_artifact', // 代码对象
  'evidence', // 证据
  'misconception', // 误区
  'gate', // 门禁
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

/** 主层级节点：参与 L0→L5 的树/图结构，孤儿检查只针对这些类型。 */
export const MAIN_LAYER_TYPES = [
  'project',
  'outcome',
  'work_package',
  'competency',
  'practice',
  'knowledge',
] as const;

export type MainLayerType = (typeof MAIN_LAYER_TYPES)[number];

/** 节点生命周期状态。AI 只能产出 candidate/unresolved，approved/published 由教师给。 */
export const NODE_STATUSES = [
  'candidate', // AI 或教研提出，未审核
  'unresolved', // 存在待教师决定的歧义
  'approved', // 教师已审核
  'published', // 已发布给学生
  'stale', // 绑定的代码对象已移动/失效
  'deprecated', // 被新版取代
] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];

/** bundle 级生命周期；与节点状态分离，避免类型层把 draft 写成 candidate。 */
export const BUNDLE_STATUSES = [
  'draft',
  'in_review',
  'approved',
  'published',
  'superseded',
] as const;

export type BundleStatus = (typeof BUNDLE_STATUSES)[number];

/** 课程覆盖边界：当前 cgroup 样板只做到项目先导准备度。 */
export const CURRICULUM_MODES = [
  'pre_project_readiness',
  'project_execution',
  'end_to_end',
] as const;

export type CurriculumMode = (typeof CURRICULUM_MODES)[number];

/** 知识节点的作用域：通用积木 vs 项目特有。 */
export const NODE_SCOPES = ['canonical', 'project'] as const;
export type NodeScope = (typeof NODE_SCOPES)[number];

/** 实践任务脚手架等级，来自规范第 7 节。 */
export const TASK_LEVELS = ['T1', 'T2', 'T3', 'T4'] as const;
export type TaskLevel = (typeof TASK_LEVELS)[number];

/** 前置关系的强度分类，来自规范 Step 6。 */
export const REQUIREMENT_KINDS = [
  'required', // 不具备就无法安全开始
  'just_in_time', // 做到某一步时补充
  'remediation', // 失败后定向补学
  'extension', // 提高视野，不阻塞主线
] as const;

export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

// ── 关系类型 ──────────────────────────────────────────────────────────

export const EDGE_TYPES = [
  'DECOMPOSES_TO',
  'REQUIRES',
  'PREREQUISITE_OF',
  'PROVEN_BY',
  'ELICITED_BY',
  'USES',
  'AFFECTS',
  'TESTED_BY',
  'DERIVED_FROM',
  'HAS_MISCONCEPTION',
  'REMEDIATED_BY',
  'ALTERNATIVE_TO',
  'CONTRIBUTES_TO',
  'BINDS', // project_binding → canonical knowledge
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

/**
 * 参与「严格前置」环检测的关系。
 *
 * 只有这两类表达教学上的硬顺序；`REQUIRES` 中 requirement_kind 非 required 的
 * 边不参与环检测（协同学习不算成环）。见 PTKG003。
 */
export const STRICT_PREREQUISITE_EDGES = ['PREREQUISITE_OF', 'REQUIRES'] as const;

/** 复用关系，用于跨项目搭积木。来自 04 号方案第 7.3 节。 */
export const REUSE_RELATIONS = [
  'EXACT_REUSE',
  'SPECIALIZES',
  'EXTENDS',
  'ALTERNATIVE',
  'CONFLICTS',
  'DEPRECATED_BY',
] as const;

export type ReuseRelation = (typeof REUSE_RELATIONS)[number];

// ── 来源可信级别 ──────────────────────────────────────────────────────

/**
 * A=仓库固定 commit / 官方规范原文；B=官方项目页 / 维护者声明；
 * C=第三方文档 / 社区文章；D=推测或 LLM 常识（项目事实不得只靠 D）。
 */
export const TRUST_LEVELS = ['A', 'B', 'C', 'D'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

// ── 校验规则 ──────────────────────────────────────────────────────────

/** 严重度。blocker 阻断发布，review 需人工看，info 仅提示。 */
export const SEVERITIES = ['blocker', 'review', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * 稳定规则码，来自 08 号方案第 8 节。
 *
 * 这些码是 CLI、MCP 和教师网页之间的共同语言，编号一经发布不得改变含义，
 * 只能追加新码。规则实现见 `src/rules/`。
 */
export const RULE_CODES = [
  'PTKG001', // 必填字段缺失
  'PTKG002', // 引用不存在节点
  'PTKG003', // 严格前置关系成环
  'PTKG004', // 必修能力无直接证据
  'PTKG005', // 专业/项目必修知识无实践
  'PTKG006', // repo artifact 无固定 ref
  'PTKG007', // 项目事实仅有 D 级来源
  'PTKG008', // 孤儿节点，不贡献任何项目结果
  'PTKG009', // 疑似重复 canonical node
  'PTKG010', // 项目 binding 与 canonical 定义冲突
  'PTKG011', // 动态高风险内容未经审核
  'PTKG012', // 节点/来源已 stale
  'PTKG013', // 审核/发布状态缺少教师授权
  'PTKG014', // 未决问题与 unresolved 状态不一致
] as const;

export type RuleCode = (typeof RULE_CODES)[number];

/** 单条校验发现。`path` 用 JSON Pointer 风格指向出问题的字段。 */
export interface Finding {
  code: RuleCode;
  severity: Severity;
  /** 出问题的节点/边 id；跨多个对象时用 subjects。 */
  subject: string;
  subjects?: string[];
  message: string;
  /** 文件内定位，便于教师直接跳转。 */
  file?: string;
  path?: string;
  /** 修复建议，面向教师而非机器。 */
  hint?: string;
}

// ── Bundle 数据结构 ───────────────────────────────────────────────────

export interface RepoArtifactRef {
  repo: string;
  /** 必须是固定 commit SHA，不能是分支名。见 PTKG006。 */
  ref: string;
  path: string;
  symbol?: string | null;
  role?: string;
}

export interface DifficultyModel {
  prerequisite_depth?: number;
  subsystem_span?: number;
  concurrency?: number;
  source_maturity?: number;
  error_consequence?: number;
  test_observability?: number;
}

/** 所有节点的公共字段。各 type 的专有字段用可选属性表达，由 JSON Schema 做条件必填。 */
export interface PtkgNode {
  id: string;
  type: NodeType;
  title: string;
  status: NodeStatus;
  scope?: NodeScope;

  // knowledge / competency
  statement?: string;
  claim?: string;
  conditions?: string[];
  quality_criteria?: string[];
  difficulty?: DifficultyModel;
  misconceptions?: string[];
  diagnostic?: string;
  remediation?: string[];

  // project
  mission?: string;
  repository?: { url: string; ref: string };
  target_environment?: Record<string, string>;
  curriculum_scope?: {
    mode: CurriculumMode;
    entry: string;
    exit: string;
    readiness_criteria: string[];
    excluded_responsibilities?: string[];
  };
  outcomes?: string[];
  acceptance?: Record<string, string[]>;
  non_goals?: string[];
  student_model?: Record<string, string>;
  unresolved_questions?: string[];

  // outcome / work_package
  parent_outcome_id?: string;
  project_value?: string;
  system_boundary?: string;
  inputs?: string[];
  deliverables?: string[];
  interfaces?: string[];
  risks?: string[];
  definition_of_done?: string[];

  // practice
  task_level?: TaskLevel;
  scenario?: string;
  student_responsibility?: string[];
  provided_scaffolds?: string[];
  allowed_changes?: string[];
  tests?: Record<string, string[]>;
  uses_repo_artifacts?: RepoArtifactRef[];
  safety?: string[];

  // project_binding
  canonical_node_id?: string;
  project_id?: string;
  project_semantics?: string;
  repo_artifacts?: RepoArtifactRef[];
  used_by_work_packages?: string[];
  practice_ids?: string[];
  differences_from_canonical?: string[];
  reuse_relation?: ReuseRelation;

  // evidence
  evidence_kind?: string;
  artifacts?: string[];
  collection?: string;
  reviewer?: string;
  validity?: Record<string, unknown>;
  mastery_weight?: string;

  // repo_artifact
  repo?: string;
  ref?: string;
  path?: string;
  symbol?: string | null;

  // 通用
  source_ids?: string[];
  tags?: string[];
  /** 是否为 AI 动态生成的高风险内容，见 PTKG011。 */
  generated?: {
    by: string;
    at?: string;
    high_stakes?: boolean;
    reviewed_by?: string | null;
  };
  notes?: string;
}

export interface PtkgEdge {
  id: string;
  from: string;
  type: EdgeType;
  to: string;
  status: NodeStatus;
  requirement_kind?: RequirementKind;
  source_ids?: string[];
  notes?: string;
}

export interface PtkgSource {
  id: string;
  type: 'source';
  source_kind: string;
  title: string;
  url?: string;
  local_path?: string;
  retrieved_at: string;
  version_or_ref?: string | null;
  trust_level: TrustLevel;
  supports?: string[];
  notes?: string;
}

export interface PtkgManifest {
  ptkg_version: string;
  bundle_id: string;
  title: string;
  status: BundleStatus;
  language?: string;
  created_at?: string;
  curriculum_version?: string;
  project_ref: { repository_url: string; git_ref: string };
  generator?: { tool: string; tool_version?: string; authoring_kit_version?: string };
  approval?: { status: BundleStatus; approved_by?: string | null };
  files?: Record<string, string>;
}

/** 载入并解析后的完整 bundle。 */
export interface PtkgBundle {
  manifest: PtkgManifest;
  nodes: PtkgNode[];
  edges: PtkgEdge[];
  sources: PtkgSource[];
  /** 各部分来自哪个文件，用于 findings 定位。 */
  origin: { manifest: string; nodes: string; edges: string; sources: string };
}

// ── 工具函数 ──────────────────────────────────────────────────────────

/** 固定 commit SHA：必须是完整 40 位；缩写 SHA 可能随仓库增长而产生歧义。 */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export function isFixedCommitRef(ref: string | undefined | null): boolean {
  if (!ref) return false;
  return COMMIT_SHA.test(ref.trim());
}

export function isMainLayer(type: NodeType): boolean {
  return (MAIN_LAYER_TYPES as readonly string[]).includes(type);
}
