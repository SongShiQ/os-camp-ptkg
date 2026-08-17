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

固定 commit 已实现 `try_charge_memory` / `uncharge_memory`：它们沿祖先路径计费，用 `MembershipState.charged_mem` 记录 pid 总量，并在超限、迁移和退出时回滚、转移或释放。宿主测试覆盖了计费对称、超限事件、迁移和层级计费。

排除测试目录后的 commit-wide 搜索只找到这两个 API 的声明，没有 StarryOS 页分配或释放路径的生产调用者。因此当前只能证明计费机制 API，不能证明应用内存分配受到限制。验证必须同时观察配置、计数、超限失败和释放后恢复；通过宿主 OOM 制造失败既不安全，也不能补上 allocator 接入证据。
