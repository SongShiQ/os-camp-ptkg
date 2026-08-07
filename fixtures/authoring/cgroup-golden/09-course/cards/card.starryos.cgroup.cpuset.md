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

cpuset 要处理集合解析、父子有效集合和配置传播，但最终证据是任务没有运行到集合之外的 CPU。属性写入成功或回读一致都不足以证明亲和性已经下发。

课程用固定多 vCPU QEMU 观察实际 CPU，并覆盖空集合、越界 CPU 和超出父集合等负例。当前实现状态保持 `partial`，未核实连接点继续标记 unresolved。
