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

五控制器矩阵应同时列出触发事件、controller 状态、内核连接点、失败与清理路径、直接验证证据。pids 对应 fork/exit，cpu 对应调度，memory 对应页分配，cpuset 对应亲和性，io 对应块层。

矩阵中的实现状态和教学成熟度必须分开。源码部分存在可以标 `partial`，没有可靠锚点则标 `unresolved`。这些工作包用于倒推课程完整性，不是给学生分配真实项目任务。
