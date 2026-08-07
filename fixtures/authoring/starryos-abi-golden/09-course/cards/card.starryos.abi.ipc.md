---
id: card.starryos.abi.ipc
title: System V IPC 与共享内存生命周期
unit_ids:
  - unit.starryos.abi.ipc
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.subsystems
  - kc.os.process.lifecycle
  - kc.os.concurrency.lock-and-lifetime
source_refs:
  - src.starryos.abi.ipc
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`os/StarryOS/kernel/src/syscall/ipc/mod.rs`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `600adf37493bc7bc3397d03895c2efc2939870f5`。

本单元的行为边界是：核实对象标识、权限、消息复制、共享内存 attach/detach、删除时机和并发引用生命周期。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
