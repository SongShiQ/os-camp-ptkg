/**
 * 教学语义规则：PTKG004 / PTKG005 / PTKG006 / PTKG007 / PTKG009 / PTKG010 /
 * PTKG011 / PTKG012 / PTKG013 / PTKG014。
 *
 * 这一层承载方案 00 号文件的「不可违背的边界」。它们不是代码洁癖，而是把
 * 「读知识卡不授予 mastery」「必修知识必须绑实践」「项目事实必须绑 commit」
 * 这些教学纪律变成机器可拒收的条件——否则约束只存在于提示词里，AI 想绕就能绕。
 */

import type { Finding, PtkgBundle, PtkgNode, TrustLevel } from '../types.ts';
import { isFixedCommitRef } from '../types.ts';

/** 证据强度：来自规范 Step 4 的五级表。高层能力不能只由低强度证据证明。 */
const EVIDENCE_STRENGTH: Record<string, number> = {
  explanation: 1,
  diagram: 1,
  code_trace: 2,
  controlled_change: 3,
  work_package: 4,
  code_contribution: 4,
  integration: 5,
  defense: 5,
};

/**
 * PTKG004：必修能力无直接证据。
 *
 * 一个 competency 必须有 PROVEN_BY 边指向 evidence 节点。只有 candidate 状态
 * 且明确标注 extension 的可以豁免——那不是必修。
 */
export function checkCompetencyEvidence(
  bundle: PtkgBundle,
  byId: Map<string, PtkgNode>,
): Finding[] {
  const findings: Finding[] = [];

  const provenBy = new Map<string, string[]>();
  for (const edge of bundle.edges) {
    if (edge?.type !== 'PROVEN_BY' || !edge.from || !edge.to) continue;
    const list = provenBy.get(edge.from) ?? [];
    list.push(edge.to);
    provenBy.set(edge.from, list);
  }

  for (const node of bundle.nodes) {
    if (node?.type !== 'competency') continue;
    if (node.status === 'deprecated') continue;

    const evidenceIds = provenBy.get(node.id) ?? [];
    // proven_by 也允许写在节点内联字段里，两种写法都接受
    const inline = Array.isArray((node as { proven_by?: string[] }).proven_by)
      ? ((node as { proven_by?: string[] }).proven_by as string[])
      : [];
    const all = [...new Set([...evidenceIds, ...inline])];

    if (all.length === 0) {
      findings.push({
        code: 'PTKG004',
        severity: 'blocker',
        subject: node.id,
        message: `能力 \`${node.id}\` 没有任何证据：缺少指向 evidence 节点的 PROVEN_BY 边。`,
        file: bundle.origin.nodes,
        hint: '按原则五，能力必须有可验证证据。补一个 evidence 节点（代码贡献、测试报告、评审记录等）并连 PROVEN_BY。',
      });
      continue;
    }

    // 检查证据强度：T3/T4 级别的能力不能只靠"解释/绘图"证明
    const strengths = all
      .map((id) => byId.get(id))
      .filter((n): n is PtkgNode => n !== undefined && n.type === 'evidence')
      .map((n) => EVIDENCE_STRENGTH[n.evidence_kind ?? ''] ?? 0);

    const best = strengths.length > 0 ? Math.max(...strengths) : 0;
    const claim = node.claim ?? '';
    const looksImplementation = /实现|编码|修改|集成|设计并/.test(claim);

    if (looksImplementation && best > 0 && best <= 2) {
      findings.push({
        code: 'PTKG004',
        severity: 'review',
        subject: node.id,
        message: `能力 \`${node.id}\` 声称包含实现/修改动作，但最强证据只有 ${best} 级（解释或代码追踪）。`,
        file: bundle.origin.nodes,
        hint: '按规范 Step 4，高层能力不能只由低强度证据证明。补一个 controlled_change / code_contribution 级证据。',
      });
    }
  }

  return findings;
}

/**
 * PTKG005：项目必修知识无实践。
 *
 * 这是「实践优先」原则的执行点：一个 knowledge 节点如果被项目必修引用，
 * 就必须至少关联一个 practice。只有 extension 类可以纯阅读。
 */
export function checkKnowledgePractice(
  bundle: PtkgBundle,
  byId: Map<string, PtkgNode>,
): Finding[] {
  const findings: Finding[] = [];

  // 收集「被实践 REQUIRES 的知识」和「被 extension 关系引用的知识」
  const practicedKnowledge = new Set<string>();
  const extensionOnly = new Set<string>();

  for (const edge of bundle.edges) {
    if (!edge?.from || !edge?.to) continue;

    const fromNode = byId.get(edge.from);
    if (edge.type === 'REQUIRES' && fromNode?.type === 'practice') {
      if (edge.requirement_kind === 'extension') {
        extensionOnly.add(edge.to);
      } else {
        practicedKnowledge.add(edge.to);
      }
    }
    // practice → USES → knowledge 也算关联
    if (edge.type === 'USES' && fromNode?.type === 'practice') {
      practicedKnowledge.add(edge.to);
    }
  }

  // 节点内联的 practice_ids 同样算
  for (const node of bundle.nodes) {
    if (!node?.id) continue;
    for (const pid of node.practice_ids ?? []) {
      if (byId.get(pid)?.type === 'practice') practicedKnowledge.add(node.id);
    }
  }

  for (const node of bundle.nodes) {
    if (node?.type !== 'knowledge') continue;
    if (node.status === 'deprecated') continue;

    // 只管必修：scope=project 的知识，或被 required 边引用的
    const isProjectScoped = node.scope === 'project';
    const isRequired = bundle.edges.some(
      (e) =>
        e?.to === node.id &&
        e.type === 'REQUIRES' &&
        (e.requirement_kind === undefined || e.requirement_kind === 'required'),
    );

    if (!isProjectScoped && !isRequired) continue;
    if (practicedKnowledge.has(node.id)) continue;
    if (extensionOnly.has(node.id) && !isProjectScoped) continue;

    findings.push({
      code: 'PTKG005',
      severity: 'blocker',
      subject: node.id,
      message: `必修知识 \`${node.id}\` 没有关联任何实践任务。`,
      file: bundle.origin.nodes,
      hint: '按原则三，专业/项目阶段的必修叶节点至少绑定一个真实代码对象和一个实践证据。补一个 practice 节点并连 REQUIRES/USES，或把该知识降级为 extension。',
    });
  }

  return findings;
}

/**
 * PTKG006：repo artifact 无固定 ref。
 *
 * 分支名会漂移。方案 09 节明确要求「项目事实优先使用仓库固定 commit」，
 * information/02 更指出目标 PR 分支是活动分支——写分支名等于写了一个会失效的事实。
 */
export function checkFixedRefs(bundle: PtkgBundle): Finding[] {
  const findings: Finding[] = [];

  const inspect = (
    nodeId: string,
    artifacts: { repo?: string; ref?: string; path?: string }[] | undefined,
    field: string,
  ): void => {
    if (!Array.isArray(artifacts)) return;
    for (let i = 0; i < artifacts.length; i++) {
      const a = artifacts[i];
      if (!a) continue;
      if (!isFixedCommitRef(a.ref)) {
        findings.push({
          code: 'PTKG006',
          severity: 'blocker',
          subject: nodeId,
          message: `\`${nodeId}\` 的 ${field}[${i}] 的 ref 不是固定 commit：\`${a.ref ?? '(缺失)'}\`。`,
          file: bundle.origin.nodes,
          path: `/${field}/${i}/ref`,
          hint: '填 40 位 commit sha，不要写分支名。tgoskits 的 dev 与两个 PR 分支都在漂移，分支名记录的事实会立刻失效。',
        });
      }
    }
  };

  for (const node of bundle.nodes) {
    if (!node?.id) continue;

    inspect(node.id, node.repo_artifacts, 'repo_artifacts');
    inspect(node.id, node.uses_repo_artifacts, 'uses_repo_artifacts');

    // repo_artifact 类型节点自身的 ref
    if (node.type === 'repo_artifact' && !isFixedCommitRef(node.ref)) {
      findings.push({
        code: 'PTKG006',
        severity: 'blocker',
        subject: node.id,
        message: `代码对象 \`${node.id}\` 的 ref 不是固定 commit：\`${node.ref ?? '(缺失)'}\`。`,
        file: bundle.origin.nodes,
        path: '/ref',
      });
    }

    // project 节点的 repository.ref
    if (node.type === 'project' && node.repository && !isFixedCommitRef(node.repository.ref)) {
      findings.push({
        code: 'PTKG006',
        severity: 'blocker',
        subject: node.id,
        message: `项目 \`${node.id}\` 的 repository.ref 不是固定 commit：\`${node.repository.ref}\`。`,
        file: bundle.origin.nodes,
        path: '/repository/ref',
        hint: '项目合同必须锁定 commit。见 07 号方案 Phase 0 门禁。',
      });
    }
  }

  // manifest 的 project_ref 同样要锁
  const gitRef = bundle.manifest?.project_ref?.git_ref;
  if (gitRef !== undefined && !isFixedCommitRef(gitRef)) {
    findings.push({
      code: 'PTKG006',
      severity: 'blocker',
      subject: bundle.manifest?.bundle_id ?? 'manifest',
      message: `manifest.project_ref.git_ref 不是固定 commit：\`${gitRef}\`。`,
      file: bundle.origin.manifest,
      path: '/project_ref/git_ref',
    });
  }

  // sources.jsonl 里的仓库文件/commit 同样承载代码事实，不能只检查节点内联引用。
  for (const source of bundle.sources) {
    if (source?.source_kind !== 'repo_file' && source?.source_kind !== 'repo_commit') continue;
    if (isFixedCommitRef(source.version_or_ref)) continue;

    findings.push({
      code: 'PTKG006',
      severity: 'blocker',
      subject: source.id,
      message: `仓库来源 \`${source.id}\` 的 version_or_ref 不是完整 40 位 commit：\`${source.version_or_ref ?? '(缺失)'}\`。`,
      file: bundle.origin.sources,
      path: '/version_or_ref',
      hint: 'repo_file / repo_commit 必须记录完整 40 位 commit。URL 指向默认分支不能替代版本绑定。',
    });
  }

  return findings;
}

/**
 * PTKG007：项目事实仅有 D 级来源。
 *
 * D 级 = 推测或 LLM 常识。原则八要求「AI 不得把猜测当成仓库事实」，
 * 这条规则就是它的机器执行版本。
 */
export function checkSourceTrust(bundle: PtkgBundle): Finding[] {
  const findings: Finding[] = [];

  const trustById = new Map<string, TrustLevel>();
  for (const s of bundle.sources) {
    if (s?.id && s.trust_level) trustById.set(s.id, s.trust_level);
  }

  // 收集每个节点的来源（内联 source_ids + DERIVED_FROM 边）
  const nodeSources = new Map<string, string[]>();
  for (const node of bundle.nodes) {
    if (!node?.id) continue;
    nodeSources.set(node.id, [...(node.source_ids ?? [])]);
  }
  for (const edge of bundle.edges) {
    if (edge?.type !== 'DERIVED_FROM' || !edge.from || !edge.to) continue;
    const list = nodeSources.get(edge.from);
    if (list) list.push(edge.to);
  }

  // 承载项目事实的节点类型：这些直接描述仓库现状，不能只靠推测
  const factBearing = new Set(['project', 'work_package', 'project_binding', 'repo_artifact']);

  for (const node of bundle.nodes) {
    if (!node?.id || !node.type) continue;
    if (!factBearing.has(node.type)) continue;
    if (node.status === 'deprecated') continue;

    const ids = nodeSources.get(node.id) ?? [];
    if (ids.length === 0) {
      findings.push({
        code: 'PTKG007',
        severity: 'review',
        subject: node.id,
        message: `\`${node.id}\`（${node.type}）承载项目事实但没有任何来源。`,
        file: bundle.origin.nodes,
        hint: '补 source_ids 或 DERIVED_FROM 边。项目事实应指向仓库固定 commit、官方文档或导师决策。',
      });
      continue;
    }

    const levels = ids.map((id) => trustById.get(id)).filter((l): l is TrustLevel => l !== undefined);
    const hasReliable = levels.some((l) => l === 'A' || l === 'B');

    if (levels.length > 0 && !hasReliable) {
      findings.push({
        code: 'PTKG007',
        severity: 'review',
        subject: node.id,
        message: `\`${node.id}\` 的项目事实只有 ${levels.join('/')} 级来源，缺少 A/B 级依据。`,
        file: bundle.origin.nodes,
        hint: 'A 级 = 仓库固定 commit 或官方规范原文；B 级 = 官方项目页或维护者声明。请补一条可核实的一手来源。',
      });
    }
  }

  return findings;
}

/** 把标题归一化后做粗粒度比对，用于找疑似重复。 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s　·・_\-—–:：,，。.()（）[\]【】]/g, '')
    .trim();
}

/**
 * PTKG009：疑似重复 canonical node。
 *
 * 「搭积木」模型的前提是通用知识不被复制。这条规则找出标题归一化后相同、
 * 或 id 尾段相同的 canonical 节点，交教师判断是复用还是特化。
 */
export function checkDuplicateCanonical(bundle: PtkgBundle): Finding[] {
  const findings: Finding[] = [];

  const canonical = bundle.nodes.filter(
    (n) => n?.type === 'knowledge' && n.scope === 'canonical' && n.status !== 'deprecated',
  );

  const byTitle = new Map<string, string[]>();
  const bySuffix = new Map<string, string[]>();

  for (const node of canonical) {
    if (!node.id) continue;

    if (node.title) {
      const key = normalizeTitle(node.title);
      if (key !== '') {
        const list = byTitle.get(key) ?? [];
        list.push(node.id);
        byTitle.set(key, list);
      }
    }

    // id 尾段：kc.os.cgroup.hierarchy-semantics → hierarchy-semantics
    const suffix = node.id.split('.').pop() ?? '';
    if (suffix !== '') {
      const list = bySuffix.get(suffix) ?? [];
      list.push(node.id);
      bySuffix.set(suffix, list);
    }
  }

  const reported = new Set<string>();

  for (const [key, ids] of byTitle) {
    if (ids.length < 2) continue;
    const dedupeKey = [...ids].sort().join('|');
    if (reported.has(dedupeKey)) continue;
    reported.add(dedupeKey);

    findings.push({
      code: 'PTKG009',
      severity: 'review',
      subject: ids[0] ?? '',
      subjects: ids,
      message: `疑似重复的通用知识积木（标题归一化后相同：\`${key}\`）：${ids.join(', ')}`,
      file: bundle.origin.nodes,
      hint: '按 04 号方案第 7 节，通用知识不应复制。若确为同一知识，保留一个 canonical 节点，用 project_binding 表达项目差异。',
    });
  }

  for (const [suffix, ids] of bySuffix) {
    if (ids.length < 2) continue;
    const dedupeKey = [...ids].sort().join('|');
    if (reported.has(dedupeKey)) continue;
    reported.add(dedupeKey);

    findings.push({
      code: 'PTKG009',
      severity: 'info',
      subject: ids[0] ?? '',
      subjects: ids,
      message: `多个 canonical 节点的 id 尾段相同（\`${suffix}\`）：${ids.join(', ')}`,
      file: bundle.origin.nodes,
      hint: '确认它们是不同知识而非同一知识被写进不同命名空间。',
    });
  }

  return findings;
}

/**
 * PTKG010：project_binding 与 canonical 定义冲突。
 *
 * 冲突本身不是错误——StarryOS 与 Linux 语义确实会有差异。错误是「冲突没被
 * 显式记录」，那会让学生按 Linux 语义写出编译不过的代码（正是 ERRATA 勘误 3 的坑）。
 */
export function checkBindingConflicts(
  bundle: PtkgBundle,
  byId: Map<string, PtkgNode>,
): Finding[] {
  const findings: Finding[] = [];

  for (const node of bundle.nodes) {
    if (node?.type !== 'project_binding') continue;
    if (node.status === 'deprecated') continue;

    const canonicalId = node.canonical_node_id;
    if (!canonicalId) continue; // PTKG001 负责必填
    const canonical = byId.get(canonicalId);
    if (!canonical) continue; // PTKG002 负责悬空引用

    if (node.reuse_relation === 'CONFLICTS') {
      const hasDifferences =
        Array.isArray(node.differences_from_canonical) &&
        node.differences_from_canonical.length > 0;

      if (!hasDifferences) {
        findings.push({
          code: 'PTKG010',
          severity: 'blocker',
          subject: node.id,
          message: `binding \`${node.id}\` 标为 CONFLICTS，但没有说明与 canonical \`${canonicalId}\` 的差异。`,
          file: bundle.origin.nodes,
          path: '/differences_from_canonical',
          hint: 'CONFLICTS 必须逐条写出差异，否则学生会按通用语义写出错误代码。参考 ERRATA 勘误 3（axfs-ng-vfs vs axfs_vfs）。',
        });
      }

      if (node.status !== 'unresolved') {
        findings.push({
          code: 'PTKG010',
          severity: 'review',
          subject: node.id,
          message: `binding \`${node.id}\` 标为 CONFLICTS，应交教师判断，status 建议为 unresolved（当前 \`${node.status}\`）。`,
          file: bundle.origin.nodes,
          path: '/status',
        });
      }
    }

    // 声明 SPECIALIZES/EXTENDS 却没写差异，等于没说明特化在哪
    if (
      (node.reuse_relation === 'SPECIALIZES' || node.reuse_relation === 'EXTENDS') &&
      (!Array.isArray(node.differences_from_canonical) ||
        node.differences_from_canonical.length === 0)
    ) {
      findings.push({
        code: 'PTKG010',
        severity: 'review',
        subject: node.id,
        message: `binding \`${node.id}\` 声明 ${node.reuse_relation} 但未说明差异。`,
        file: bundle.origin.nodes,
        path: '/differences_from_canonical',
        hint: '特化关系必须写清项目在哪一点上与通用知识不同，否则复用判断无法审核。',
      });
    }
  }

  return findings;
}

/**
 * PTKG011：动态高风险内容未经审核。
 *
 * 原则八的底线：AI 不得自动发布高风险内容。这里检查 generated.high_stakes
 * 为真但 reviewed_by 为空的节点。
 */
export function checkHighStakesReview(bundle: PtkgBundle): Finding[] {
  const findings: Finding[] = [];

  for (const node of bundle.nodes) {
    if (!node?.id) continue;
    const gen = node.generated;
    if (!gen?.high_stakes) continue;

    const reviewed = gen.reviewed_by !== undefined && gen.reviewed_by !== null && gen.reviewed_by !== '';

    if (!reviewed && (node.status === 'candidate' || node.status === 'unresolved')) {
      findings.push({
        code: 'PTKG011',
        severity: 'review',
        subject: node.id,
        message: `\`${node.id}\` 是尚未审核的 AI 高风险候选内容。`,
        file: bundle.origin.nodes,
        path: '/generated/reviewed_by',
        hint: '候选阶段可以提交教师审核，但发布前必须填写 generated.reviewed_by，并由服务端验证审核者身份。',
      });
    }

    if ((node.status === 'approved' || node.status === 'published') && !reviewed) {
      findings.push({
        code: 'PTKG011',
        severity: 'blocker',
        subject: node.id,
        message: `\`${node.id}\` 未经高风险内容审核却已是 ${node.status} 状态。`,
        file: bundle.origin.nodes,
        path: '/status',
        hint: 'AI 不得自行把 candidate 改为 approved/published。见规范 Step 8。',
      });
    }
  }

  return findings;
}

/**
 * PTKG013：审核/发布状态缺少教师授权。
 *
 * Authoring Kit 允许 AI 生成 draft，但批准动作必须留下教师身份。CLI 只能检查
 * 身份字段是否存在；网页端还必须用登录态验证该身份，不能信任客户端自报。
 */
export function checkApprovalAuthority(bundle: PtkgBundle): Finding[] {
  const findings: Finding[] = [];
  const approval = bundle.manifest?.approval;
  const approver = approval?.approved_by?.trim();
  const hasTeacherApproval = Boolean(approver);

  if (bundle.manifest.status !== 'draft' && !hasTeacherApproval) {
    findings.push({
      code: 'PTKG013',
      severity: 'blocker',
      subject: bundle.manifest.bundle_id ?? 'manifest',
      message: `bundle 状态为 \`${bundle.manifest.status}\`，但 approval.approved_by 为空。`,
      file: bundle.origin.manifest,
      path: '/approval/approved_by',
      hint: 'AI 只能产出 draft。in_review / approved / published 必须由教师工作台写入并由服务端验证身份。',
    });
  }

  if (approval && approval.status !== bundle.manifest.status) {
    findings.push({
      code: 'PTKG013',
      severity: 'blocker',
      subject: bundle.manifest.bundle_id ?? 'manifest',
      message: `manifest.status（${bundle.manifest.status}）与 approval.status（${approval.status}）不一致。`,
      file: bundle.origin.manifest,
      path: '/approval/status',
      hint: '状态变更必须走同一个教师审核事务，不能只改其中一个字段。',
    });
  }

  if (!hasTeacherApproval) {
    for (const node of bundle.nodes) {
      if (node?.status !== 'approved' && node?.status !== 'published') continue;
      findings.push({
        code: 'PTKG013',
        severity: 'blocker',
        subject: node.id,
        message: `节点 \`${node.id}\` 已是 ${node.status}，但 bundle 没有教师授权记录。`,
        file: bundle.origin.nodes,
        path: '/status',
        hint: 'Agent 产出只能使用 candidate / unresolved；教师批准与发布由工作台执行。',
      });
    }
    for (const edge of bundle.edges) {
      if (edge?.status !== 'approved' && edge?.status !== 'published') continue;
      findings.push({
        code: 'PTKG013',
        severity: 'blocker',
        subject: edge.id,
        message: `关系 \`${edge.id}\` 已是 ${edge.status}，但 bundle 没有教师授权记录。`,
        file: bundle.origin.edges,
        path: '/status',
        hint: 'Agent 产出只能使用 candidate / unresolved；教师批准与发布由工作台执行。',
      });
    }
  }

  return findings;
}

/** PTKG014：存在待教师决定的问题时，节点必须显式处于 unresolved。 */
export function checkUnresolvedState(bundle: PtkgBundle): Finding[] {
  const findings: Finding[] = [];

  for (const node of bundle.nodes) {
    if (!Array.isArray(node?.unresolved_questions) || node.unresolved_questions.length === 0) continue;
    if (node.status === 'unresolved') continue;

    findings.push({
      code: 'PTKG014',
      severity: 'blocker',
      subject: node.id,
      message: `\`${node.id}\` 有 ${node.unresolved_questions.length} 个 unresolved_questions，但状态是 \`${node.status}\`。`,
      file: bundle.origin.nodes,
      path: '/status',
      hint: '只要仍有待教师裁决的问题，就必须使用 status: unresolved，不能把它伪装成普通 candidate。',
    });
  }

  return findings;
}

/**
 * PTKG012：节点或来源已 stale。
 *
 * 报告已标记 stale 的节点，以及来源抓取日期过旧的情况。方案 09 节要求
 * 「代码对象发生移动时，节点标记 stale，不得静默指向新路径」——这条规则
 * 让 stale 状态在校验输出里可见，而不是躺在字段里没人看。
 */
export function checkStale(bundle: PtkgBundle, staleAfterDays: number = 180): Finding[] {
  const findings: Finding[] = [];

  for (const node of bundle.nodes) {
    if (node?.status !== 'stale') continue;
    findings.push({
      code: 'PTKG012',
      severity: 'review',
      subject: node.id,
      message: `\`${node.id}\` 已标记为 stale，绑定的代码对象可能已移动。`,
      file: bundle.origin.nodes,
      hint: '重新核实代码路径并更新 ref，或走影响分析流程。不要静默改路径。',
    });
  }

  // 来源抓取日期过旧：仓库事实会漂移，超过阈值就该重新核实
  const now = Date.now();
  const thresholdMs = staleAfterDays * 24 * 60 * 60 * 1000;

  for (const source of bundle.sources) {
    if (!source?.id || !source.retrieved_at) continue;
    const retrieved = Date.parse(source.retrieved_at);
    if (Number.isNaN(retrieved)) continue;

    if (now - retrieved > thresholdMs) {
      const days = Math.floor((now - retrieved) / (24 * 60 * 60 * 1000));
      findings.push({
        code: 'PTKG012',
        severity: 'info',
        subject: source.id,
        message: `来源 \`${source.id}\` 的抓取日期为 ${source.retrieved_at}（${days} 天前），可能已过期。`,
        file: bundle.origin.sources,
        hint: '重新核实并更新 retrieved_at。仓库类来源尤其容易漂移。',
      });
    }
  }

  return findings;
}
