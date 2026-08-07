---
id: card.starryos.cgroup.provider-decoupling
title: CgroupProvider 把内核原语留在宿主边界
unit_ids:
  - unit.starryos.cgroup.provider-decoupling
node_ids:
  - competency.starryos.cgroup.provider-implement
  - kc.rust.static-dyn-singleton
  - evidence.starryos.cgroup.provider-impl
source_refs:
  - src.axcgroup.provider-rs
  - src.axcgroup.cargotoml
  - src.starryos.cgroup-kernel-rs
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

独立 `ax-cgroup` crate 不应直接依赖内核 task 或 hal。`CgroupProvider` 把查询成员、当前身份和状态通知等原语由内核实现注入，使核心逻辑可用 mock 在宿主环境验证。

保存 `&'static dyn Trait` 的单例涉及真实 unsafe 合同：对象生命周期、唯一或受控注册、初始化顺序和并发读取都必须成立。`AtomicPtr` 本身不会自动证明这些前提。
