---
id: card.starryos.abi.dispatch-arch
title: syscall 分发与多架构编号差异
unit_ids:
  - unit.starryos.abi.dispatch-arch
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.contracts
source_refs:
  - src.starryos.abi.dispatch-arch
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`os/StarryOS/kernel/src/syscall/mod.rs`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `9db1f94fb40f55818122f7864638f4bfd6a0f42e`。

本单元的行为边界是：从 trap 上下文参数提取追踪到 Sysno 分支、架构 cfg、错误映射和返回寄存器，识别 ENOSYS 与伪成功的差别。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
