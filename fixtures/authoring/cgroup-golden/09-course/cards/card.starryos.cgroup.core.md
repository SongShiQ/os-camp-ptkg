---
id: card.starryos.cgroup.core
title: cgroup core 是层级状态机，不是目录名集合
unit_ids:
  - unit.starryos.cgroup.core
node_ids:
  - kc.os.cgroup.hierarchy-semantics
  - binding.starryos.cgroup.hierarchy@fc80b86
source_refs:
  - src.axcgroup.core-rs
  - src.axcgroup.libr-rs
  - src.linux.cgroup-v2-doc
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

cgroup core 同时维护父子层级、成员关系、控制器可见性和生命周期。理解一个节点必须追踪它如何创建、被查找、接受成员、启用子树控制器并在满足不变量后删除。

学习时把 Linux cgroup v2 规则和 StarryOS 固定实现分栏记录。规范说明期望语义，源码说明当前实现，执行证据说明行为是否真的发生；三者不能相互替代。
