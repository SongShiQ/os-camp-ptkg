/**
 * 校验结果输出。
 *
 * 两种格式：
 *   - text：给教师在终端看，按规则码分组，带修复建议；
 *   - json：给网页/CI 消费，字段稳定。
 *
 * 不使用颜色转义和表情符号：输出会被贴进 issue、日志和汇报文档。
 */

import type { Finding, RuleCode } from './types.ts';
import type { ValidateResult } from './validate.ts';

/** 规则码的人类可读标题，与 08 号方案第 8 节的表格一致。 */
export const RULE_DESCRIPTIONS: Record<RuleCode, string> = {
  PTKG001: '必填字段缺失或结构不合法',
  PTKG002: '引用不存在的节点',
  PTKG003: '严格前置关系成环',
  PTKG004: '必修能力无直接证据',
  PTKG005: '项目必修知识无实践',
  PTKG006: 'repo artifact 无固定 commit',
  PTKG007: '项目事实仅有 D 级来源',
  PTKG008: '孤儿节点，不贡献任何项目结果',
  PTKG009: '疑似重复 canonical node',
  PTKG010: 'binding 与 canonical 定义冲突',
  PTKG011: '高风险动态内容未经审核',
  PTKG012: '节点或来源已 stale',
  PTKG013: '审核/发布状态缺少教师授权',
  PTKG014: '未决问题与 unresolved 状态不一致',
};

function groupByCode(findings: Finding[]): Map<RuleCode, Finding[]> {
  const groups = new Map<RuleCode, Finding[]>();
  for (const f of findings) {
    const list = groups.get(f.code) ?? [];
    list.push(f);
    groups.set(f.code, list);
  }
  return groups;
}

export interface FormatOptions {
  /** 每条规则最多列出多少条，避免首次校验刷屏。0 表示不限。 */
  limitPerRule?: number;
  /** 同上，CLI 侧的别名（--max）。两者都给时以 maxPerCode 为准。 */
  maxPerCode?: number;
  /** 只打印 blocker。`ptkg lint` 用它做 CI 门禁输出。 */
  blockersOnly?: boolean;
  /** 是否打印修复建议。默认打印；--no-hints 可关掉。 */
  hints?: boolean;
}

export function formatText(result: ValidateResult, options: FormatOptions = {}): string {
  const limit = options.maxPerCode ?? options.limitPerRule ?? 10;
  const showHints = options.hints !== false;
  const lines: string[] = [];
  const { summary } = result;

  lines.push('PTKG 校验报告');
  lines.push('='.repeat(60));
  lines.push('');

  const c = summary.counts;
  lines.push(`节点 ${c.nodes} · 边 ${c.edges} · 来源 ${c.sources}`);
  if (Object.keys(c.byType).length > 0) {
    const typeLine = Object.entries(c.byType)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t} ${n}`)
      .join(' · ');
    lines.push(`节点构成：${typeLine}`);
  }
  lines.push('');

  if (summary.total === 0) {
    lines.push('未发现问题。bundle 结构合法，可进入教师审核。');
    return lines.join('\n');
  }

  lines.push(`发现 ${summary.total} 项：blocker ${summary.blocker} · review ${summary.review} · info ${summary.info}`);
  lines.push('');

  const groups = groupByCode(result.findings);
  const codes = [...groups.keys()].sort();

  for (const code of codes) {
    const items = groups.get(code)!;
    const severity = items[0]?.severity ?? 'info';
    lines.push(`[${code}] ${RULE_DESCRIPTIONS[code]} — ${items.length} 项（${severity}）`);
    lines.push('-'.repeat(60));

    const shown = limit > 0 ? items.slice(0, limit) : items;
    for (const f of shown) {
      const loc = f.file ? ` (${f.file}${f.path ?? ''})` : '';
      lines.push(`  · ${f.message}${loc}`);
    }
    if (limit > 0 && items.length > limit) {
      lines.push(`  … 还有 ${items.length - limit} 项，用 --only ${code} --limit 0 查看全部`);
    }

    // 同一规则的 hint 通常相同，只在组末打印一次，避免重复噪音
    const hint = shown.find((f) => f.hint)?.hint;
    if (hint) {
      lines.push('');
      lines.push(`  修复建议：${hint}`);
    }
    lines.push('');
  }

  lines.push('='.repeat(60));
  lines.push(
    result.passed
      ? '无 blocker：可进入教师审核。review 项需人工判断，不阻断。'
      : '存在 blocker：必须修复后才能提交审核或发布。',
  );

  return lines.join('\n');
}

export function formatJson(result: ValidateResult): string {
  return JSON.stringify(
    {
      passed: result.passed,
      summary: result.summary,
      findings: result.findings,
    },
    null,
    2,
  );
}

/**
 * 生成 08 号方案第 7 节的「PTKG Generation Report」骨架。
 *
 * 这份报告是教师审核的入口文档：它把机器可测的覆盖率算好，把需要人判断的
 * 部分留成待填空，而不是让 AI 自己给自己打分。
 */
export function formatGenerationReport(result: ValidateResult): string {
  const { summary, bundle } = result;
  const c = summary.counts;
  const nodes = bundle?.nodes ?? [];

  const competencies = nodes.filter((n) => n.type === 'competency');
  const knowledge = nodes.filter((n) => n.type === 'knowledge');
  const project = nodes.find((n) => n.type === 'project');
  const sources = bundle?.sources ?? [];
  const goodSources = sources.filter((s) => s.trust_level === 'A' || s.trust_level === 'B');

  const pct = (part: number, whole: number): string =>
    whole === 0 ? 'n/a' : `${Math.round((part / whole) * 100)}%`;

  const competencyGaps = summary.byCode.PTKG004 ?? 0;
  const knowledgeGaps = summary.byCode.PTKG005 ?? 0;
  const unresolved = nodes.filter((n) => n.status === 'unresolved').length;

  const lines: string[] = [];
  lines.push('# PTKG Generation Report');
  lines.push('');
  lines.push('## 输入');
  lines.push('');
  lines.push(`- repo/ref：${bundle?.manifest.project_ref?.repository_url ?? '未填'} @ ${bundle?.manifest.project_ref?.git_ref ?? '未填'}`);
  lines.push(`- bundle_id：${bundle?.manifest.bundle_id ?? '未填'}`);
  lines.push(`- 作者工具：${bundle?.manifest.generator?.tool ?? '未填'}`);
  lines.push(`- 课程模式：${project?.curriculum_scope?.mode ?? '未填'}`);
  lines.push(`- 课程出口：${project?.curriculum_scope?.exit ?? '未填'}`);
  if ((project?.curriculum_scope?.readiness_criteria.length ?? 0) > 0) {
    lines.push('- 项目准备度标准：');
    for (const criterion of project!.curriculum_scope!.readiness_criteria) {
      lines.push(`  - ${criterion}`);
    }
  }
  lines.push('');
  lines.push('## 输出统计');
  lines.push('');
  for (const [type, count] of Object.entries(c.byType).sort()) {
    lines.push(`- ${type}：${count}`);
  }
  lines.push(`- 边：${c.edges}`);
  lines.push(`- 来源：${c.sources}`);
  lines.push('');
  lines.push('## 质量');
  lines.push('');
  lines.push(`- 能力—证据覆盖率：${pct(competencies.length - competencyGaps, competencies.length)}（缺 ${competencyGaps}）`);
  lines.push(`- 知识—实践覆盖率：${pct(knowledge.length - knowledgeGaps, knowledge.length)}（缺 ${knowledgeGaps}）`);
  lines.push(`- A/B 级来源占比：${pct(goodSources.length, sources.length)}`);
  lines.push(`- unresolved 节点：${unresolved}`);
  lines.push(`- 严格前置环：${summary.byCode.PTKG003 ?? 0}`);
  lines.push(`- 孤儿节点：${summary.byCode.PTKG008 ?? 0}`);
  lines.push(`- 未固定 commit 的代码引用：${summary.byCode.PTKG006 ?? 0}`);
  lines.push('');
  lines.push('## 复用');
  lines.push('');
  const bindings = nodes.filter((n) => n.type === 'project_binding');
  const byRelation: Record<string, number> = {};
  for (const b of bindings) {
    const rel = b.reuse_relation ?? '未标注';
    byRelation[rel] = (byRelation[rel] ?? 0) + 1;
  }
  if (bindings.length === 0) {
    lines.push('- 无 project_binding 节点');
  } else {
    for (const [rel, n] of Object.entries(byRelation).sort()) lines.push(`- ${rel}：${n}`);
  }
  lines.push(`- 疑似重复 canonical：${summary.byCode.PTKG009 ?? 0}`);
  lines.push(`- 定义冲突：${summary.byCode.PTKG010 ?? 0}`);
  lines.push('');
  lines.push('## 需要教师决定');
  lines.push('');
  const unresolvedQuestions = nodes.flatMap((node) =>
    (node.unresolved_questions ?? []).map((question) => ({ nodeId: node.id, question })),
  );
  const decisions = result.findings.filter(
    (f) =>
      f.code === 'PTKG007' ||
      f.code === 'PTKG010' ||
      f.code === 'PTKG011' ||
      f.code === 'PTKG013' ||
      f.code === 'PTKG014',
  );
  if (unresolvedQuestions.length === 0 && decisions.length === 0) {
    lines.push('（无自动检出项；仍需教师确认内容正确性、体验质量与发布节奏）');
  } else {
    for (const item of unresolvedQuestions.slice(0, 20)) {
      lines.push(`- [UNRESOLVED] ${item.nodeId}：${item.question}`);
    }
    for (const d of decisions.slice(0, 20)) lines.push(`- [${d.code}] ${d.message}`);
  }
  lines.push('');
  lines.push('## 高风险变更');
  lines.push('');
  const risky = result.findings.filter((f) => f.code === 'PTKG011' || f.code === 'PTKG012');
  if (risky.length === 0) {
    lines.push('（无）');
  } else {
    for (const r of risky.slice(0, 20)) lines.push(`- [${r.code}] ${r.message}`);
  }
  lines.push('');

  return lines.join('\n');
}
