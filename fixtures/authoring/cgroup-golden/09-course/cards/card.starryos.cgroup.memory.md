---
id: card.starryos.cgroup.memory
title: memory 控制贯穿分配、拒绝、释放与恢复
unit_ids:
  - unit.starryos.cgroup.memory
node_ids:
  - outcome.starryos.cgroup.controller-framework
  - project.starryos.cgroup
source_refs:
  - src.axcgroup.memory-rs
  - src.starryos.cgroup-kernel-rs
  - src.tgoskits.pr1379
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

memory controller 文件存在只证明状态与接口代码对象存在。资源控制还需要页分配 charge、超限拒绝、释放 uncharge 和失败回滚连接到真实内核生命周期。

验证必须同时观察配置、计数、超限失败和释放后重新可分配。通过宿主 OOM 制造失败既不安全，也不能证明 StarryOS cgroup memory enforcement。
