---
id: card.starryos.abi.abi-contract
title: Linux ABI 合同、errno 与跨架构数据布局
unit_ids:
  - unit.starryos.abi.abi-contract
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.contracts
source_refs:
  - src.starryos.abi.abi-contract
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`os/StarryOS/kernel/src/syscall/mod.rs`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `9db1f94fb40f55818122f7864638f4bfd6a0f42e`。

本单元的行为边界是：把 syscall number、参数宽度、结构体布局、flags、返回值和 Linux errno 作为一个不可拆散的外部合同核实。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
