---
id: card.starryos.abi.rust-no-std
title: Rust no_std 与内核能力边界
unit_ids:
  - unit.starryos.abi.rust-no-std
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.contracts
  - kc.rust.no-std.kernel-boundaries
source_refs:
  - src.starryos.abi.rust-no-std
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`Cargo.toml`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `50e26804db3869ed5ec7ae4007b327e83fa6edb7`。

本单元的行为边界是：区分 core/alloc、宿主 std、平台 crate 与初始化顺序，避免把宿主示例直接复制进内核。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
