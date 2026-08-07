/**
 * 校验编排层。
 *
 * 把 loader + 全部稳定规则串成一次完整校验，产出稳定排序的 findings。
 * 这个函数是 CLI 与（后续）网页导入端唯一的共同入口——两边必须调同一个
 * 函数，否则会出现「CLI 过了但网页拒收」，正是 08 号方案末尾警告的情况。
 */

import { loadBundle } from './loader.ts';
import { checkSchema } from './rules/schema.ts';
import {
  checkDanglingRefs,
  checkOrphans,
  checkPrerequisiteCycles,
  indexNodes,
} from './rules/graph.ts';
import {
  checkApprovalAuthority,
  checkBindingConflicts,
  checkCompetencyEvidence,
  checkDuplicateCanonical,
  checkFixedRefs,
  checkHighStakesReview,
  checkKnowledgePractice,
  checkSourceTrust,
  checkStale,
  checkUnresolvedState,
} from './rules/pedagogy.ts';
import { RULE_CODES } from './types.ts';
import type { Finding, PtkgBundle, RuleCode, Severity } from './types.ts';

export interface ValidateOptions {
  /** 只跑指定规则；为空表示全部。用于教师分批修问题。 */
  only?: RuleCode[];
  /** 跳过指定规则。 */
  skip?: RuleCode[];
  /** 来源过期阈值（天）。 */
  staleAfterDays?: number;
}

export interface ValidateResult {
  bundle: PtkgBundle | null;
  findings: Finding[];
  summary: {
    total: number;
    blocker: number;
    review: number;
    info: number;
    byCode: Record<string, number>;
    /** 统计信息，用于生成报告。 */
    counts: {
      nodes: number;
      edges: number;
      sources: number;
      byType: Record<string, number>;
    };
  };
  /** 是否可以进入教师审核：没有 blocker 即可。 */
  passed: boolean;
}

const SEVERITY_ORDER: Record<Severity, number> = { blocker: 0, review: 1, info: 2 };

/** 稳定排序：先按严重度，再按规则码，再按 subject。保证同一 bundle 每次输出一致。 */
function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0;
  });
}

export async function validateBundle(
  dir: string,
  options: ValidateOptions = {},
): Promise<ValidateResult> {
  const { bundle, findings: loadFindings } = await loadBundle(dir);

  const enabled = (code: RuleCode): boolean => {
    if (options.only && options.only.length > 0) return options.only.includes(code);
    if (options.skip && options.skip.includes(code)) return false;
    return true;
  };

  const all: Finding[] = [...loadFindings];

  if (bundle) {
    const { byId, findings: indexFindings } = indexNodes(bundle);
    all.push(...indexFindings);

    if (enabled('PTKG001')) all.push(...(await checkSchema(bundle)));
    if (enabled('PTKG002')) all.push(...checkDanglingRefs(bundle, byId));
    if (enabled('PTKG003')) all.push(...checkPrerequisiteCycles(bundle));
    if (enabled('PTKG004')) all.push(...checkCompetencyEvidence(bundle, byId));
    if (enabled('PTKG005')) all.push(...checkKnowledgePractice(bundle, byId));
    if (enabled('PTKG006')) all.push(...checkFixedRefs(bundle));
    if (enabled('PTKG007')) all.push(...checkSourceTrust(bundle));
    if (enabled('PTKG008')) all.push(...checkOrphans(bundle, byId));
    if (enabled('PTKG009')) all.push(...checkDuplicateCanonical(bundle));
    if (enabled('PTKG010')) all.push(...checkBindingConflicts(bundle, byId));
    if (enabled('PTKG011')) all.push(...checkHighStakesReview(bundle));
    if (enabled('PTKG012')) all.push(...checkStale(bundle, options.staleAfterDays));
    if (enabled('PTKG013')) all.push(...checkApprovalAuthority(bundle));
    if (enabled('PTKG014')) all.push(...checkUnresolvedState(bundle));
  }

  const findings = sortFindings(all);

  const byCode: Record<string, number> = {};
  for (const code of RULE_CODES) byCode[code] = 0;
  for (const f of findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;

  const byType: Record<string, number> = {};
  for (const node of bundle?.nodes ?? []) {
    if (!node?.type) continue;
    byType[node.type] = (byType[node.type] ?? 0) + 1;
  }

  const blocker = findings.filter((f) => f.severity === 'blocker').length;
  const review = findings.filter((f) => f.severity === 'review').length;
  const info = findings.filter((f) => f.severity === 'info').length;

  return {
    bundle,
    findings,
    summary: {
      total: findings.length,
      blocker,
      review,
      info,
      byCode,
      counts: {
        nodes: bundle?.nodes.length ?? 0,
        edges: bundle?.edges.length ?? 0,
        sources: bundle?.sources.length ?? 0,
        byType,
      },
    },
    passed: blocker === 0,
  };
}
