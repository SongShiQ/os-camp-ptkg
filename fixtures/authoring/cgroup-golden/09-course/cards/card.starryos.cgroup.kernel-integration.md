---
id: card.starryos.cgroup.kernel-integration
title: 控制器只有接到内核事件才成为资源控制
unit_ids:
  - unit.starryos.cgroup.kernel-integration
node_ids:
  - outcome.starryos.cgroup.controller-framework
  - competency.starryos.cgroup.provider-implement
  - project.starryos.cgroup
source_refs:
  - src.starryos.cgroup-kernel-rs
  - src.axcgroup.cpu-rs
  - src.axcgroup.memory-rs
  - src.axcgroup.cpuset-rs
  - src.axcgroup.io-rs
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定 commit 的生产连接矩阵并不整齐：成员/provider 与 pids 生命周期链存在；CPU tick 会计存在，但调度器不消费 throttle 标志；memory 有 charge API，但 allocator 不调用；cpuset 有 effective 传播，但 task affinity 不调用；io 只保存配置且明确没有块层节流。

每个控制器都要分别列出配置、状态、生产触发、执行效果和测试证据，再标记 `present/partial/absent/unresolved`。实现状态和教学成熟度必须分开：功能可以是 partial，但其边界审计仍可成为 teachable 的项目先导实践。这些工作包用于倒推课程完整性，不是给学生分配真实项目任务。
