---
id: card.starryos.cgroup.membership
title: 成员迁移是一组可回滚的生命周期事务
unit_ids:
  - unit.starryos.cgroup.membership
node_ids:
  - kc.os.cgroup.hierarchy-semantics
  - evidence.starryos.cgroup.pids-lab
source_refs:
  - src.axcgroup.libr-rs
  - src.starryos.cgroup-kernel-rs
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

迁移、fork 和 exit 会同时影响成员所属、祖先计费和控制器状态。把它们只看成一次赋值会遗漏中途失败、最后线程退出和并发交错带来的半状态。

用 prepare、commit、rollback 描述事务：prepare 校验并预留，commit 原子切换，rollback 释放预留并恢复旧关系。证据应包含失败注入、清理断言和计数不负、不重复归还等不变量。
