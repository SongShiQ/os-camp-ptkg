/**
 * 图结构规则：PTKG002 / PTKG003 / PTKG008。
 *
 * 这些规则只看节点与边的拓扑，不看教学语义。
 */

import type { Finding, PtkgBundle, PtkgEdge, PtkgNode } from '../types.ts';
import { isMainLayer } from '../types.ts';

/** 建立 id → 节点索引，同时报告重复 id。 */
export function indexNodes(bundle: PtkgBundle): {
  byId: Map<string, PtkgNode>;
  findings: Finding[];
} {
  const byId = new Map<string, PtkgNode>();
  const findings: Finding[] = [];

  for (const node of bundle.nodes) {
    if (!node?.id) continue; // 缺 id 由 PTKG001 负责
    if (byId.has(node.id)) {
      findings.push({
        code: 'PTKG001',
        severity: 'blocker',
        subject: node.id,
        message: `节点 id 重复：\`${node.id}\` 出现多次。`,
        file: bundle.origin.nodes,
        hint: 'id 必须全局唯一。若确实是两个不同节点，给其中一个换 id；若是同一节点被写了两遍，删掉重复行。',
      });
      continue;
    }
    byId.set(node.id, node);
  }

  return { byId, findings };
}

/**
 * PTKG002：边引用了不存在的节点。
 *
 * source 节点单独存放在 sources.jsonl 里，DERIVED_FROM 的终点要在那里找，
 * 所以校验时要把两个命名空间合起来看。
 */
export function checkDanglingRefs(bundle: PtkgBundle, byId: Map<string, PtkgNode>): Finding[] {
  const findings: Finding[] = [];
  const sourceIds = new Set(bundle.sources.map((s) => s?.id).filter(Boolean) as string[]);

  const exists = (id: string): boolean => byId.has(id) || sourceIds.has(id);

  for (const edge of bundle.edges) {
    if (!edge?.id) continue;
    for (const [side, id] of [
      ['from', edge.from],
      ['to', edge.to],
    ] as const) {
      if (!id) continue;
      if (!exists(id)) {
        findings.push({
          code: 'PTKG002',
          severity: 'blocker',
          subject: edge.id,
          message: `边 \`${edge.id}\` 的 ${side} 指向不存在的节点 \`${id}\`。`,
          file: bundle.origin.edges,
          path: `/${side}`,
          hint: '检查是否拼错 id，或该节点尚未写入 nodes.jsonl / sources.jsonl。',
        });
      }
    }
  }

  // 节点内部的 id 引用同样要查，否则教师网页渲染时会拿到空对象
  const inlineRefs: { field: keyof PtkgNode; label: string }[] = [
    { field: 'canonical_node_id', label: 'canonical_node_id' },
    { field: 'parent_outcome_id', label: 'parent_outcome_id' },
    { field: 'project_id', label: 'project_id' },
  ];

  for (const node of bundle.nodes) {
    if (!node?.id) continue;

    for (const { field, label } of inlineRefs) {
      const value = node[field];
      if (typeof value === 'string' && value !== '' && !exists(value)) {
        findings.push({
          code: 'PTKG002',
          severity: 'blocker',
          subject: node.id,
          message: `节点 \`${node.id}\` 的 ${label} 指向不存在的节点 \`${value}\`。`,
          file: bundle.origin.nodes,
          path: `/${label}`,
        });
      }
    }

    for (const listField of ['used_by_work_packages', 'practice_ids', 'source_ids'] as const) {
      const list = node[listField];
      if (!Array.isArray(list)) continue;
      for (const ref of list) {
        if (typeof ref === 'string' && ref !== '' && !exists(ref)) {
          findings.push({
            code: 'PTKG002',
            severity: 'blocker',
            subject: node.id,
            message: `节点 \`${node.id}\` 的 ${listField} 引用了不存在的 \`${ref}\`。`,
            file: bundle.origin.nodes,
            path: `/${listField}`,
          });
        }
      }
    }
  }

  return findings;
}

/**
 * 判断一条边是否构成「严格前置」。
 *
 * 这是 PTKG003 的核心判断，也是最容易误报的地方：规范 Step 7 明确说
 * 「若出现环，检查是否把协同关系误写成严格前置」。因此只有
 *   - PREREQUISITE_OF，或
 *   - requirement_kind 为 required（或未标注，默认从严）的 REQUIRES
 * 才算硬顺序。just_in_time / remediation / extension 允许成环，因为它们
 * 表达的是「做到这步再补」而不是「不学完不能开始」。
 */
function isStrictPrerequisite(edge: PtkgEdge): boolean {
  if (edge.type === 'PREREQUISITE_OF') return true;
  if (edge.type === 'REQUIRES') {
    return edge.requirement_kind === undefined || edge.requirement_kind === 'required';
  }
  return false;
}

/**
 * PTKG003：严格前置关系成环。
 *
 * 用迭代式 DFS（三色标记）找出具体环路径，而不是只说「图里有环」——
 * 教师需要知道是哪几个节点互相卡住了才能修。递归实现在深图上会爆栈，
 * 所以这里手写显式栈。
 */
export function checkPrerequisiteCycles(bundle: PtkgBundle): Finding[] {
  const adjacency = new Map<string, { to: string; edgeId: string }[]>();

  for (const edge of bundle.edges) {
    if (!edge?.from || !edge?.to || !isStrictPrerequisite(edge)) continue;
    const list = adjacency.get(edge.from) ?? [];
    list.push({ to: edge.to, edgeId: edge.id });
    adjacency.set(edge.from, list);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const findings: Finding[] = [];
  const reported = new Set<string>();

  for (const start of adjacency.keys()) {
    if ((color.get(start) ?? WHITE) !== WHITE) continue;

    // stack 里存「节点 + 还没遍历的邻居下标」，pathStack 维护当前 DFS 路径
    const stack: { node: string; index: number }[] = [{ node: start, index: 0 }];
    const pathStack: string[] = [start];
    color.set(start, GRAY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;

      const neighbors = adjacency.get(frame.node) ?? [];

      if (frame.index >= neighbors.length) {
        color.set(frame.node, BLACK);
        stack.pop();
        pathStack.pop();
        continue;
      }

      const neighbor = neighbors[frame.index];
      frame.index++;
      if (neighbor === undefined) continue;
      const to = neighbor.to;

      const state = color.get(to) ?? WHITE;
      if (state === GRAY) {
        // 找到回边，从 pathStack 里截出环
        const cycleStart = pathStack.indexOf(to);
        const cycle = cycleStart >= 0 ? [...pathStack.slice(cycleStart), to] : [frame.node, to];

        // 同一个环从不同起点会被发现多次，用排序后的成员集合去重
        const key = [...new Set(cycle)].sort().join('|');
        if (!reported.has(key)) {
          reported.add(key);
          findings.push({
            code: 'PTKG003',
            severity: 'blocker',
            subject: cycle[0] ?? frame.node,
            subjects: cycle,
            message: `严格前置关系成环：${cycle.join(' → ')}`,
            file: bundle.origin.edges,
            hint: '检查是否把「协同学习」误写成严格前置。若两者确实需要一起学，改用 requirement_kind: just_in_time，或合并为一个共同学习簇。',
          });
        }
      } else if (state === WHITE) {
        color.set(to, GRAY);
        stack.push({ node: to, index: 0 });
        pathStack.push(to);
      }
    }
  }

  return findings;
}

/**
 * PTKG008：孤儿节点——不贡献任何项目结果。
 *
 * 判定方式是从 project 节点出发做反向可达性分析：一个主层级节点只要能通过
 * 任意结构边连回某个 project，就算有归属。这比「入度为 0」准确得多，
 * 因为叶子知识节点本来就没有入边，但它通过 REQUIRES 被实践反向依赖。
 */
export function checkOrphans(bundle: PtkgBundle, byId: Map<string, PtkgNode>): Finding[] {
  const projects = bundle.nodes.filter((n) => n?.type === 'project').map((n) => n.id);
  if (projects.length === 0) {
    // 没有 project 节点是更严重的问题，PTKG001 会在 manifest/节点层面报，这里不重复
    return [];
  }

  // 建无向邻接：孤儿判定只关心「是否与项目同一连通块」，方向不重要
  const undirected = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (!a || !b) return;
    if (!undirected.has(a)) undirected.set(a, new Set());
    if (!undirected.has(b)) undirected.set(b, new Set());
    undirected.get(a)!.add(b);
    undirected.get(b)!.add(a);
  };

  for (const edge of bundle.edges) {
    if (!edge?.from || !edge?.to) continue;
    // DERIVED_FROM 指向 source，不表达项目归属，排除以免所有节点因共享来源而"连通"
    if (edge.type === 'DERIVED_FROM') continue;
    link(edge.from, edge.to);
  }

  for (const node of bundle.nodes) {
    if (!node?.id) continue;
    if (node.parent_outcome_id) link(node.id, node.parent_outcome_id);
    if (node.canonical_node_id) link(node.id, node.canonical_node_id);
    if (node.project_id) link(node.id, node.project_id);
    for (const wp of node.used_by_work_packages ?? []) link(node.id, wp);
    for (const p of node.practice_ids ?? []) link(node.id, p);
  }

  const reachable = new Set<string>(projects);
  const queue = [...projects];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const next of undirected.get(current) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  const findings: Finding[] = [];
  for (const node of bundle.nodes) {
    if (!node?.id || !node.type) continue;
    if (!isMainLayer(node.type)) continue;
    if (node.type === 'project') continue;
    if (reachable.has(node.id)) continue;

    findings.push({
      code: 'PTKG008',
      severity: 'review',
      subject: node.id,
      message: `孤儿节点：\`${node.id}\`（${node.type}）无法追溯到任何 project。`,
      file: bundle.origin.nodes,
      hint: '按原则一，无法关联项目能力或共享工程底座的内容不应进入主线。要么补一条通往工作包/项目的边，要么标为 extension 或移出必修。',
    });
  }

  return findings;
}
