---
id: card.starryos.cgroup.delegation
title: 委派语义必须区分规范、实现和未知
unit_ids:
  - unit.starryos.cgroup.delegation
node_ids:
  - kc.os.cgroup.hierarchy-semantics
  - binding.starryos.cgroup.hierarchy@fc80b86
source_refs:
  - src.linux.cgroup-v2-doc
  - src.axcgroup.core-rs
  - src.axcgroup.libr-rs
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

`cgroup.controllers` 描述可用控制器，`cgroup.subtree_control` 决定向子层级启用哪些控制器；no-internal-process 等规则约束域控制器如何委派。

Linux 文档是 canonical 语义来源，StarryOS 固定源码是项目 binding。每条规则都应记录 `present/partial/absent/conflicting/unresolved`、对应代码和验证方法，不能用规范默认补齐实现空白。
