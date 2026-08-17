---
id: card.starryos.cgroup.cpuset
title: cpuset 的终点是任务实际运行位置
unit_ids:
  - unit.starryos.cgroup.cpuset
node_ids:
  - outcome.starryos.cgroup.controller-framework
  - project.starryos.cgroup
source_refs:
  - src.axcgroup.cpuset-rs
  - src.starryos.cgroup-kernel-rs
  - src.tgoskits.pr1379
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定 commit 会解析 `cpuset.cpus/mems`，并由 `recompute_cpuset_effective` 沿子树计算父 effective 与子 request 的交集；宿主测试覆盖父节点收窄和放宽后的传播。这个链路证明配置和 effective 状态能工作。

源码中存在 axtask affinity API，但没有发现 cpuset 把 effective mask 下发给现有任务或新任务的生产调用者；配置传播不能证明任务亲和性已经生效。最终证据仍应是任务没有运行到集合之外的 CPU；在桥接补齐前，课程用状态矩阵和验证设计教学，并覆盖空 effective、越界 CPU、父子并发更新等边界，implementation_state 保持 `partial`。
