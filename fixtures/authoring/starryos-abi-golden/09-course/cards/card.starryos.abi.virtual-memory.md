---
id: card.starryos.abi.virtual-memory
title: brk/mmap/mprotect 与地址空间不变量
unit_ids:
  - unit.starryos.abi.virtual-memory
node_ids:
  - project.starryos.linux-abi
  - outcome.starryos.abi.subsystems
  - kc.os.concurrency.lock-and-lifetime
source_refs:
  - src.starryos.abi.virtual-memory
status: candidate
generated_by:
  tool: "@os-camp/ptkg"
  version: 0.4.0
  agent: g5-golden-course
content_hash: ""
---

固定源码：`os/StarryOS/kernel/src/syscall/mm/mmap.rs`，commit `fc80b868fb3640efe8997994de42c1aee8fd74cb`，blob `fc48d47101454aa58362f5927aa623db0dceb33f`。

本单元的行为边界是：核实地址对齐、匿名/文件映射、权限、重叠、回收和失败原子性，并用负例区分参数接受与真实映射生效。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。

学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 `unresolved`。
