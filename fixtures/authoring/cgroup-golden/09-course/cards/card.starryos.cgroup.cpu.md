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

固定 commit 中存在 cpu controller 和内核 cpu 接入文件，但 coverage 状态是 `partial`。课程必须分开核实属性解析、内部记账和调度器 enforcement，不能从文件名推导完整行为。

高保真验证使用相同负载和固定 QEMU vCPU，只改变 cgroup 配置并比较 CPU 时间或完成量。绕过调度连接点的 seeded fault 应被测试识别。
