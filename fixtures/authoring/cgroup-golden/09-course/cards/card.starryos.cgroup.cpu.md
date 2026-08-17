---
id: card.starryos.cgroup.cpu
title: cpu 配置存在不等于调度限速生效
unit_ids:
  - unit.starryos.cgroup.cpu
node_ids:
  - outcome.starryos.cgroup.controller-framework
  - project.starryos.cgroup
source_refs:
  - src.axcgroup.cpu-rs
  - src.starryos.cgroup-kernel-rs
  - src.tgoskits.pr1379
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定 commit 会解析 `cpu.max`，boot 时注册 `bandwidth_tick`，tick 会更新带宽计数并调用 `TaskInner::set_throttled`。但 commit-wide 搜索没有找到调度器调用 `TaskInner::is_throttled`；`weight_to_nice` 也只有宿主测试调用。因此当前能证明配置、会计和标志发布，不能证明调度器真的跳过受限任务。

学习时必须把“配置可读写、tick 会计变化、任务标志变化、调度结果变化”分成四栏。高保真验证使用相同负载和固定 QEMU vCPU，只改变 cgroup 配置并比较 CPU 时间或完成量；在调度器消费者补齐前，该验证只能作为待执行设计，不能写成已通过。
